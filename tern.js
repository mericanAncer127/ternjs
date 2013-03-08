// FIXME needs re-entrancy when using this for HTTP

(function(exports) {
  "use strict";

  var infer, condense;
  if (typeof require != "undefined") {
    infer = require("./infer.js");
    condense = require("./condense.js");
  } else {
    infer = condense = exports;
  }

  var plugins = Object.create(null);
  exports.registerPlugin = function(name, init) { plugins[name] = init; };

  var Server = exports.Server = function(callbacks, environment) {
    this.cx = null;
    this.callbacks = callbacks;
    this.environment = [];
    this.filesToLoad = [];
    this.handlers = {};

    this.pendingFiles = [];
    this.files = this.uses = 0;
    if (environment) for (var i = 0; i < environment.length; ++i)
      this.addEnvironment(environment[i]);
  };
  Server.prototype = {
    addEnvironment: function(data) {
      this.environment.push(data);
      var plugin = data["!plugin"];
      if (plugin && plugin in plugins) plugins[plugin](this);
    },
    addFile: function(file) {
      if (this.filesToLoad.indexOf(file) < 0) this.filesToLoad.push(file);
    },
    delFile: function(file) {
      var found = this.filesToLoad.indexOf(file);
      if (found > -1) this.filesToLoad.splice(found, 1);
    },
    reset: function() {
      this.cx = new infer.Context(this.environment, this);
      this.uses = 0;
      this.files = [];
      this.pendingFiles = this.filesToLoad.slice(0);
      this.signal("reset");
    },

    // Used from inside the analyzer to load, for example, a
    // `require`-d file.
    require: function(filename) {
      this.pendingFiles.push(filename);
    },

    request: function(doc, c) {
      // FIXME somehow validate doc's structure (at least for HTTP reqs)

      var self = this, files = doc.files || [];
      if (!this.cx) this.reset();
      doRequest(this, doc, function(err, data) {
        c(err, data);
        // FIXME better heuristic for when to reset
        if (++self.cx.uses > 20) {
          self.reset();
          finishPending(self, function(){});
        }
      });
    },

    findFile: function(name) {
      return this.files && findFile(this.files, name);
    },

    on: function(type, f) {
      (this.handlers[type] || (this.handlers[type] = [])).push(f);
    },
    off: function(type, f) {
      var arr = this.handlers[type];
      if (arr) for (var i = 0; i < arr.length; ++i)
        if (arr[i] == f) { arr.splice(i, 1); break; }
    },
    signal: function(type, v1, v2, v3, v4) {
      var arr = this.handlers[type];
      if (arr) for (var i = 0; i < arr.length; ++i) arr[i].call(this, v1, v2, v3, v4);
    }
  };

  function doRequest(srv, doc, c) {
    var files = doc.files || [];
    for (var i = 0; i < files.length; ++i) {
      var file = files[i];
      if (file.type == "full") loadFile(srv, file.name, file.text);
    }

    infer.withContext(srv.cx, function() {
      resolveFile(srv, files, doc.query.file, function(err, file) {
        if (err) return c(err);
        finishPending(srv, function(err) {
          if (err) return c(err);
          var result;
          try {
            switch (doc.query.type) {
            case "completions":
              result = findCompletions(file, doc.query); break;
            case "type":
              result = findTypeAt(file, doc.query); break;
            case "definition":
              if (file.type == "part") throw new Error("Can't run a definition query on a file fragment");
              result = findDef(file, doc.query); break;
            case "refs":
              if (file.type == "part") throw new Error("Can't run a uses query on a file fragment");
              result = findRefs(srv, file, doc.query); break;
            default:
              throw new Error("Unsupported query type: " + doc.query.type);
            }
          } catch (e) { c(e.message || String(e)); }
          return c(null, result);
        });
      });
    });
  }

  function loadFile(srv, filename, text) {
    return infer.withContext(srv.cx, function() {
      var file = {name: filename, text: text};
      srv.signal("beforeLoad", file);
      var result = infer.analyze(file.text, filename);
      var known = findFile(srv.files, filename);
      if (!known) srv.files.push(known = {name: filename});
      known.text = file.text;
      known.ast = result.ast;
      srv.signal("afterLoad", known);
      return known;
    });
  }

  function finishPending(srv, c) {
    var next;
    while (next = srv.pendingFiles.pop())
      if (!findFile(srv.files, next)) break;
    if (!next) return c();

    srv.callbacks.getFile(next, function(err, text) {
      if (err) return c(err);
      loadFile(srv, next, text);
      finishPending(srv, c);
    });
  }

  function findFile(arr, name) {
    for (var i = 0; i < arr.length; ++i) {
      var file = arr[i];
      if (file.name == name && file.type != "part") return file;
    }
  }

  function firstLine(str) {
    var end = str.indexOf("\n");
    if (end < 0) return str;
    return str.slice(0, end);
  }

  function findMatchingPosition(line, file, near) {
    var pos = 0, closest = null;
    if (!/^\s*$/.test(line)) for (;;) {
      var found = file.indexOf(line, pos);
      if (found < 0) break;
      if (closest == null || Math.abs(closest - near) > Math.abs(found - near))
        closest = found;
      pos = found + line.length;
    }
    return closest;
  }

  function resolveFile(srv, localFiles, name, c) {
    var file, isRef = name.match(/^#(\d+)$/);
    if (isRef) {
      file = localFiles[isRef[1]];
      if (!file) c("Reference to unknown file " + name);
    } else {
      file = findFile(srv.files, name);
      if (!file) return srv.callbacks.getFile(name, function(err, text) {
        if (err) return c(err);
        c(null, loadFile(srv, name, text));
      });
    }

    if (file.type == "part") {
      var realFile = findFile(srv.files, file.name);
      if (!realFile) throw new Error("Partial file provided for " + file.name + ", which is not known");
      var line = firstLine(file.text);
      var foundPos = findMatchingPosition(line, realFile.text, file.position);
      var pos = foundPos == null ? Math.max(0, realFile.text.lastIndexOf("\n", file.position)) : foundPos;

      var scope = file.scope = infer.scopeAt(realFile.ast, pos), text = file.text, m;
      if (foundPos && (m = line.match(/^(.*?)\bfunction\b/))) {
        var cut = m[1].length, white = "";
        for (var i = 0; i < cut; ++i) white += " ";
        text = white + text.slice(cut);
      }
      file.ast = infer.analyze(file.text, file.name, scope).ast;

      // This is a kludge to tie together the function types (if any)
      // outside and inside of the fragment, so that arguments and
      // return values have some information known about them.
      var inner = infer.scopeAt(realFile.ast, pos + line.length);
      if (m && inner != scope && inner.fnType) {
        var newInner = infer.scopeAt(file.ast, line.length, scope);
        var fOld = inner.fnType, fNew = newInner.fnType;
        if (fNew && (fNew.name == fOld.name || !fOld.name)) {
          for (var i = 0, e = Math.min(fOld.args.length, fNew.args.length); i < e; ++i)
            fOld.args[i].propagate(fNew.args[i]);
          fOld.self.propagate(fNew.self);
          fNew.retval.propagate(fOld.retval);
        }
      }
    }
    c(null, file);
  }

  function findCompletions(file, query) {
    var wordStart = query.end, wordEnd = wordStart, text = file.text;
    while (wordStart && /\w$/.test(text.charAt(wordStart - 1))) --wordStart;
    while (wordEnd < text.length && /\w$/.test(text.charAt(wordEnd))) ++wordEnd;
    var word = text.slice(wordStart, wordEnd), completions, guessing = false;

    infer.resetGuessing();
    var memberExpr = infer.findExpressionAround(file.ast, null, wordStart, file.scope, "MemberExpression");
    if (memberExpr && !memberExpr.node.computed && memberExpr.node.object.end < wordStart) {
      memberExpr.node = memberExpr.node.object;
      var tp = infer.expressionType(memberExpr);
      if (tp)
        completions = infer.propertiesOf(tp, word);
      else
        completions = [];
    } else {
      completions = infer.localsAt(file.ast, query.end, word);
    }
    return {from: wordStart, to: wordEnd,
            completions: completions,
            guess: infer.didGuess()};
  }

  function findExpr(file, query) {
    var expr = infer.findExpressionAt(file.ast, query.start, query.end, file.scope);
    if (expr) return expr;
    expr = infer.findExpressionAround(file.ast, query.start, query.end, file.scope);
    if (expr && (query.start == null || query.start - expr.node.start < 20) &&
        expr.node.end - query.end < 20) return expr;
    throw new Error("No expression at the given position.");
  }

  function findTypeAt(file, query) {
    var expr = findExpr(file, query);
    infer.resetGuessing();
    var type = infer.expressionType(expr);
    if (query.preferFunction)
      type = type.getFunctionType() || type.getType();
    else
      type = type.getType();

    if (expr.node.type == "Identifier")
      var exprName = expr.node.name;
    else if (expr.node.type == "MemberExpression" && !expr.node.computed)
      var exprName = expr.node.property.name;

    var name = type && type.name;
    if (name && typeof name != "string") name = name.name;

    return {type: infer.toString(type, query.depth),
            name: name || null,
            exprName: exprName || null,
            guess: infer.didGuess()};
  }

  function findDef(file, query) {
    var expr = findExpr(file, query), def, file, guess = false;
    if (expr.node.type == "Identifier") {
      var found = expr.state.findVar(expr.node.name);
      if (found && typeof found.name == "object") {
        def = found.name;
        file = found.origin;
      }
    }
    if (!def) {
      infer.resetGuessing();
      var type = tern.expressionType(expr);
      if (type.types) for (var i = type.types.length - 1; i >= 0; --i) {
        var tp = type.types[i];
        if (tp.originNode) { type = tp; break; }
      }
      def = type.originNode;
      if (def) {
        if (/^Function/.test(def.type) && def.id) def = def.id;
        file = type.origin;
        guess = infer.didGuess();
      }
    }
    if (!def) throw new Error("Could not find a definition for the given expression");
    return {start: def.start, end: def.end, file: file, guess: guess};
  }

  function findRefs(srv, file, query) {
    var expr = findExpr(file, query);
    if (!expr || expr.node.type != "Identifier") throw new Error("Not at a variable.");
    var name = expr.node.name;

    for (var scope = expr.state; scope && !(name in scope.props); scope = scope.prev) {}
    if (!scope) throw new Error("Could not find a definition for " + name);

    var type, refs = [];
    function findRefsIn(file) {
      infer.findRefs(file.ast, name, scope, function(node) {
        refs.push({file: file.name, start: node.start, end: node.end});
      });
    }
    if (scope.prev) {
      type = "local";
      findRefsIn(file);
    } else {
      type = "global";
      for (var i = 0; i < srv.files.length; ++i) findRefsIn(srv.files[i]);
    }
    return {refs: refs, type: type, name: name};
  }

})(typeof exports == "undefined" ? window.tern || (window.tern = {}) : exports);
