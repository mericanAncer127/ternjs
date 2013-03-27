// The Tern server object

// A server is a stateful object that manages the analysis for a
// project, and defines an interface for querying the code in the
// project.

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    return mod(exports, require("./infer"));
  if (typeof define == "function" && define.amd) // AMD
    return define(["exports", "./infer"], mod);
  mod(self.tern || (self.tern = {}), tern); // Plain browser env
})(function(exports, infer) {
  "use strict";

  var plugins = Object.create(null);
  exports.registerPlugin = function(name, init) { plugins[name] = init; };

  var defaultOptions = {
    debug: false,
    async: false,
    getFile: function(_f, c) { if (this.async) c(null, null); },
    environment: [],
    pluginOptions: {}
  };

  var queryTypes = {
    completions: {
      takesFile: true,
      run: findCompletions
    },
    type: {
      takesFile: true,
      run: findTypeAt
    },
    definition: {
      takesFile: true,
      fullFile: true,
      run: findDef
    },
    refs: {
      takesFile: true,
      fullFile: true,
      run: findRefs
    },
    rename: {
      takesFile: true,
      fullFile: true,
      run: buildRename
    }
  };

  exports.defineQueryType = function(name, desc) { queryTypes[name] = desc; };

  function File(name, text) {
    this.name = name;
    this.text = text;
    this.ast = this.scope = null;
  }

  var Server = exports.Server = function(options) {
    this.cx = null;
    this.options = options || {};
    for (var o in defaultOptions) if (!options.hasOwnProperty(o))
      options[o] = defaultOptions[o];

    this.environment = [];
    this.handlers = {};
    this.files = [];
    this.uses = 0;

    for (var i = 0; i < options.environment.length; ++i)
      this.addEnvironment(options.environment[i]);
    this.reset();
  };
  Server.prototype = {
    addEnvironment: function(data) {
      this.environment.push(data);
      var plugin = data["!plugin"];
      if (plugin && plugin in plugins)
        plugins[plugin](this, this.options.pluginOptions[plugin]);
    },
    addFile: function(name, /*optional*/ text) {
      var known = findFile(this.files, name);
      if (!known)
        this.files.push(new File(name, text));
      else if (text != null)
        clearFile(this, known, text);
      else return;
      analyzeAll(this, function(){});
    },
    delFile: function(name) {
      for (var i = 0, f; i < this.files.length; ++i) if ((f = this.files[i]).name == name) {
        clearFile(this, f);
        this.files.splice(i--, 1);
        return;
      }
    },
    reset: function() {
      this.cx = new infer.Context(this.environment, this);
      this.uses = 0;
      for (var i = 0; i < this.files.length; ++i) clearFile(this, this.files[i]);
      this.signal("reset");
    },

    request: function(doc, c) {
      var inv = invalidDoc(doc);
      if (inv) return c(inv);

      var self = this, files = doc.files || [];
      doRequest(this, doc, function(err, data) {
        c(err, data);
        // FIXME better heuristic for when to reset
        if (++self.uses > 20) {
          self.reset();
          analyzeAll(self, function(){});
        }
      });
    },

    findFile: function(name) {
      return findFile(this.files, name);
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
    if (doc.query && !queryTypes.hasOwnProperty(doc.query.type))
      return c("No query type '" + doc.query.type + "' defined");

    var files = doc.files || [];
    for (var i = 0; i < files.length; ++i) {
      var file = files[i];
      var known = findFile(srv.files, file.name);
      if (file.type == "full") {
        if (!known) srv.files.push(new File(file.name, file.text));
        else clearFile(srv, known, file.text);
      } else if (!known) {
        srv.files.push(new File(file.name));
      }
    }

    var query = doc.query;
    if (!query) {
      c(null, {});
      analyzeAll(srv, function(){});
      return;
    }

    var queryType = queryTypes[query.type];
    if (queryType.takesFile) {
      if (typeof query.file != "string") return c(".query.file must be a string");
      if (!/^#/.test(query.file) && !findFile(srv.files, query.file))
        srv.files.push(new File(query.file));
    }

    analyzeAll(srv, function(err) {
      if (err) return c(err);
      var file = queryType.takesFile && resolveFile(srv, files, query.file);
      if (queryType.fullFile && file.type == "part")
        return("Can't run a " + query.type + " query on a file fragment");

      infer.withContext(srv.cx, function() {
        var result;
        try {
          result = queryType.run(srv, query, file);
        } catch (e) {
          if (srv.options.debug) console.log(e.stack);
          return c(e);
        }
        c(null, result);
      });
    });
  }

  function analyzeFile(srv, file) {
    infer.withContext(srv.cx, function() {
      file.scope = srv.cx.topScope;
      srv.signal("beforeLoad", file);
      infer.markVariablesDefinedBy(file.scope, file.name);
      file.ast = infer.analyze(file.text, file.name, file.scope).ast;
      infer.purgeMarkedVariables(file.scope);
      srv.signal("afterLoad", file);
    });
    return file;
  }

  function clearFile(srv, file, newText) {
    if (file.ast) {
      // FIXME try to batch purges into a single pass (each call needs
      // to traverse the whole graph)
      infer.withContext(srv.cx, function() {
        infer.purgeTypes(file.name);
      });
      file.ast = file.scope = null;
    }
    if (newText != null) file.text = newText;
  }

  function getFileText(srv, file, c) {
    if (srv.options.async) 
    try {
      file.text = srv.options.getFile(file.name) || "";
      file.lineOffsets = null;
    } catch(e) { return c(e); }
    c();
  }

  // FIXME there are re-entrancy problems in this when getFile is async
  function fetchAll(srv, c) {
    var done = true, returned = false;
    for (var i = 0; i < srv.files.length; ++i) {
      var file = srv.files[i];
      if (file.text != null) continue;
      if (srv.options.async) {
        done = false;
        srv.options.getFile(file.name, function(err, text) {
          if (err && !returned) { returned = true; return c(err); }
          file.text = text || "";
          file.lineOffsets = null;
          fetchAll(srv, c);
        });
      } else {
        try {
          file.text = srv.options.getFile(file.name) || "";
          file.lineOffsets = null;
        } catch (e) { return c(e); }
      }
    }
    if (done) c();
  }

  function analyzeAll(srv, c) {
    fetchAll(srv, function(e) {
      if (e) return c(e);
      var done = true;
      for (var i = 0; i < srv.files.length; ++i) {
        var file = srv.files[i];
        if (file.text == null) done = false;
        else if (file.ast == null) analyzeFile(srv, file);
      }
      if (done) c();
      else analyzeAll(srv, c);
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
    var pos = Math.max(0, near - 500), closest = null;
    if (!/^\s*$/.test(line)) for (;;) {
      var found = file.indexOf(line, pos);
      if (found < 0 || found > near + 500) break;
      if (closest == null || Math.abs(closest - near) > Math.abs(found - near))
        closest = found;
      pos = found + line.length;
    }
    return closest;
  }

  function resolveFile(srv, localFiles, name) {
    var isRef = name.match(/^#(\d+)$/);
    if (!isRef) return findFile(srv.files, name);

    var file = localFiles[isRef[1]];
    if (!file) throw new Error("Reference to unknown file " + name);
    if (file.type == "full") return findFile(srv.files, file.name);

    // This is a partial file

    var realFile = findFile(srv.files, file.name);
    var offset = file.offset != null ? file.offset : findLineStart(file, file.offsetLine) || 0;
    var line = firstLine(file.text);
    var foundPos = findMatchingPosition(line, realFile.text, offset);
    var pos = foundPos == null ? Math.max(0, realFile.text.lastIndexOf("\n", offset)) : foundPos;
    var retval = new File(file.name, file.text);

    infer.withContext(srv.cx, function() {
      infer.purgeTypes(file.name, pos, pos + file.text.length);

      var text = file.text, m;
      if (foundPos && (m = line.match(/^(.*?)\bfunction\b/))) {
        var cut = m[1].length, white = "";
        for (var i = 0; i < cut; ++i) white += " ";
        text = white + text.slice(cut);
      }
      var scope = retval.scope = infer.scopeAt(realFile.ast, pos, realFile.scope);
      infer.markVariablesDefinedBy(scope, file.name, pos, pos + file.text.length);
      retval.ast = infer.analyze(file.text, file.name, scope).ast;
      infer.purgeMarkedVariables(scope);

      // This is a kludge to tie together the function types (if any)
      // outside and inside of the fragment, so that arguments and
      // return values have some information known about them.
      var inner = infer.scopeAt(realFile.ast, pos + line.length, realFile.scope);
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
    });
    return retval;
  }

  function isPosition(val) {
    return typeof val == "number" || typeof val == "object" &&
      typeof val.line == "number" && typeof val.ch == "number";
  }

  // Baseline query document validation
  function invalidDoc(doc) {
    if (doc.query) {
      if (typeof doc.query.type != "string") return ".query.type must be a string";
      if (doc.query.start && !isPosition(doc.query.start)) return ".query.start must be a number";
      if (doc.query.end && !isPosition(doc.query.end)) return ".query.end must be a number";
    }
    if (doc.files) {
      if (!Array.isArray(doc.files)) return "Files property must be an array";
      for (var i = 0; i < doc.files.length; ++i) {
        var file = doc.files[i];
        if (typeof file != "object") return ".files[n] must be objects";
        else if (typeof file.text != "string") return ".files[n].text must be a string";
        else if (typeof file.name != "string") return ".files[n].name must be a string";
        else if (file.type == "part") {
          if (typeof file.offset != "number" && typeof file.offsetLines != "number")
            return ".files[n].offset or .files[n].offsetLines must be a number";
        } else if (file.type != "full") return ".files[n].type must be \"full\" or \"part\"";
      }
    }
  }

  var offsetSkipLines = 25;

  function findLineStart(file, line) {
    var text = file.text, offsets = file.lineOffsets || (file.lineOffsets = [0]);
    var pos = 0, curLine = 0;
    var storePos = Math.min(Math.floor(line / offsetSkipLines), offsets.length - 1);
    var pos = offsets[storePos], curLine = storePos * offsetSkipLines;

    while (curLine < line) {
      ++curLine;
      pos = text.indexOf("\n", pos) + 1;
      if (pos == 0) return null;
      if (curLine % offsetSkipLines == 0) offsets.push(pos);
    }
    return pos;
  }

  function resolvePos(file, pos) {
    if (typeof pos != "number") {
      var lineStart = findLineStart(file, pos.line);
      if (lineStart == null) throw new Error("File doesn't contain a line " + pos.line);
      pos = lineStart + pos.ch;
    }
    if (pos > file.text.length) throw new Error("Position " + pos + " is outside of file.");
    return pos;
  }

  function asLineChar(file, pos) {
    if (!file) return {line: 0, ch: 0};
    var offsets = file.lineOffsets || (file.lineOffsets = [0]);
    var text = file.text, line, lineStart;
    for (var i = offsets.length - 1; i >= 0; --i) if (offsets[i] <= pos) {
      line = i * offsetSkipLines;
      lineStart = offsets[i];
    }
    for (;;) {
      var eol = text.indexOf("\n", lineStart);
      if (eol >= pos || eol < 0) break;
      lineStart = eol + 1;
      ++line;
    }
    return {line: line, ch: pos - lineStart};
  }

  function outputPos(query, file, pos) {
    return query.lineCharPositions ? asLineChar(file, pos) : pos;
  }

  // Built-in query types

  function compareCompletions(a, b) {
    if (typeof a != "string") { a = a.name; b = b.name; }
    var aUp = /^[A-Z]/.test(a), bUp = /^[A-Z]/.test(b);
    if (aUp == bUp) return a < b ? -1 : a == b ? 0 : 1;
    else return aUp ? 1 : -1;
  }

  function findCompletions(srv, query, file) {
    if (query.end == null) throw new Error("missing .query.end field");
    var wordStart = resolvePos(file, query.end), wordEnd = wordStart, text = file.text;
    while (wordStart && /\w$/.test(text.charAt(wordStart - 1))) --wordStart;
    while (wordEnd < text.length && /\w$/.test(text.charAt(wordEnd))) ++wordEnd;
    var word = text.slice(wordStart, wordEnd), completions = [];
    var wrapAsObjs = query.types || query.depths;

    function gather(prop, obj, depth) {
      // 'hasOwnProperty' and such are usually just noise, leave them
      // out when no prefix is provided.
      if (query.omitObjectPrototype !== false && obj == srv.cx.protos.Object && !word) return;
      if (query.filter !== false && word && prop.indexOf(word) != 0) return;
      var val = obj.props[prop];
      for (var i = 0; i < completions.length; ++i) {
        var c = completions[i];
        if ((wrapAsObjs ? c.name : c) == prop) return;
      }
      var rec = wrapAsObjs ? {name: prop} : prop;
      completions.push(rec);

      if (query.types) {
        infer.resetGuessing();
        var type = val.getType();
        rec.guess = infer.didGuess();
        rec.type = infer.toString(type);
      }
      if (query.depths) rec.depth = depth;
    }

    var memberExpr = infer.findExpressionAround(file.ast, null, wordStart, file.scope, "MemberExpression");
    if (memberExpr && !memberExpr.node.computed && memberExpr.node.object.end < wordStart) {
      memberExpr.node = memberExpr.node.object;
      var tp = infer.expressionType(memberExpr);
      if (tp) infer.forAllPropertiesOf(tp, gather);

      if (!completions.length && word.length >= 2 && query.guess !== false)
        for (var prop in srv.cx.props) gather(prop, srv.cx.props[prop][0], 0);
    } else {
      infer.forAllLocalsAt(file.ast, wordStart, file.scope, gather);
    }

    if (query.sort !== false) completions.sort(compareCompletions);

    return {start: outputPos(query, file, wordStart),
            end: outputPos(query, file, wordEnd),
            completions: completions};
  }

  var findExpr = exports.findQueryExpr = function(file, query) {
    if (query.end == null) throw new Error("missing .query.end field");
    var start = query.start && resolvePos(file, query.start), end = resolvePos(file, query.end);
    var expr = infer.findExpressionAt(file.ast, start, end, file.scope);
    if (expr) return expr;
    expr = infer.findExpressionAround(file.ast, start, end, file.scope);
    if (expr && (start == null || start - expr.node.start < 20) &&
        expr.node.end - end < 20) return expr;
    throw new Error("No expression at the given position.");
  };

  function findTypeAt(_srv, query, file) {
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
    if (query.depth != null && typeof query.depth != "number")
      throw new Error(".query.depth must be a number");

    return {guess: infer.didGuess(),
            type: infer.toString(type, query.depth),
            name: name || null,
            exprName: exprName || null};
  }

  function findDef(srv, query, file) {
    var expr = findExpr(file, query), def, fileName, guess = false;
    if (expr.node.type == "Identifier") {
      var found = expr.state.hasProp(expr.node.name);
      if (found && typeof found.name == "object") {
        def = found.name;
        fileName = found.origin;
      }
    }
    if (!def) {
      infer.resetGuessing();
      var type = infer.expressionType(expr);
      if (type.types) for (var i = type.types.length - 1; i >= 0; --i) {
        var tp = type.types[i];
        if (tp.originNode) { type = tp; break; }
      }
      def = type.originNode;
      if (def) {
        if (/^Function/.test(def.type) && def.id) def = def.id;
        fileName = type.origin;
        guess = infer.didGuess();
      }
    }
    if (!def) throw new Error("Could not find a definition for the given expression");

    var defFile = findFile(srv.files, fileName);
    return {start: outputPos(query, defFile, def.start),
            end: outputPos(query, defFile, def.end),
            file: fileName, guess: guess};
  }

  function findRefs(srv, query, file) {
    var expr = findExpr(file, query);
    if (!expr || expr.node.type != "Identifier") throw new Error("Not at a variable.");
    var name = expr.node.name;

    for (var scope = expr.state; scope && !(name in scope.props); scope = scope.prev) {}
    if (!scope) throw new Error("Could not find a definition for " + name);

    var type, refs = [];
    function findRefsIn(file) {
      infer.findRefs(file.ast, name, scope, function(node) {
        refs.push({file: file.name,
                   start: outputPos(query, file, node.start),
                   end: outputPos(query, file, node.end)});
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

  function buildRename(srv, query, file) {
    if (typeof query.newName != "string") throw new Error(".query.newName should be a string");
    var data = findRefs(srv, query, file), refs = data.refs;
    delete data.refs;
    data.files = srv.files.map(function(f){return f.name;});

    var changes = data.changes = [];
    for (var i = 0; i < refs.length; ++i) {
      var use = refs[i];
      use.text = query.newName;
      changes.push(use);
    }

    return data;
  }
});
