(function(exports) {
  "strict mode";

  var acorn, walk;
  if (typeof require != "undefined") {
    acorn = require("acorn");
    acorn.parse_dammit = require("acorn/acorn_loose").parse_dammit;
    walk = require("acorn/util/walk");
  } else {
    acorn = window.acorn;
    walk = acorn.walk;
  }

  var toString = exports.toString = function(type, maxDepth) {
    return type ? type.toString(maxDepth) : "?";
  };

  // ABSTRACT VALUES

  var AVal = exports.AVal = function(type) {
    this.types = [];
    this.forward = null;
    this.flags = 0;
    if (type) type.propagate(this);
  };
  AVal.prototype = {
    addType: function(type) {
      if (this.types.indexOf(type) > -1) return;

      this.types.push(type);
      if (this.forward) for (var i = 0; i < this.forward.length; ++i)
        this.forward[i].addType(type);
    },

    propagate: function(c) {
      (this.forward || (this.forward = [])).push(c);
      for (var i = 0; i < this.types.length; ++i)
        c.addType(this.types[i]);
    },

    getProp: function(prop) {
      var found = (this.props || (this.props = Object.create(null)))[prop];
      if (!found) {
        found = this.props[prop] = new AVal;
        this.propagate(new PropIsSubset(prop, found));
      }
      return found;
    },

    forAllProps: function(c) {
      this.propagate(new ForAllProps(c));
    },

    hasType: function(type) {
      return this.types.indexOf(type) > -1;
    },
    isEmpty: function() { return this.types.length == 0; },
    getFunctionType: function() {
      // FIXME find most complete one?
      for (var i = 0; i < this.types.length; ++i)
        if (this.types[i] instanceof Fn) return this.types[i];
    },

    getType: function(guess) {
      if (this.types.length == 0 && guess !== false) return this.makeupType();
      if (this.types.length == 1) return this.types[0];
      return canonicalType(this.types);
    },

    makeupType: function() {
      guessing = true;
      if (!this.forward) return null;
      for (var i = 0; i < this.forward.length; ++i) {
        var fw = this.forward[i], hint = fw.typeHint && fw.typeHint();
        if (hint && !hint.isEmpty()) return hint;
      }

      var props = Object.create(null), foundProp = null;
      for (var i = 0; i < this.forward.length; ++i) {
        var fw = this.forward[i], prop = fw.propHint && fw.propHint();
        if (prop && prop != "length" && prop != "<i>" && prop != "✖") {
          props[prop] = true;
          foundProp = prop;
        }
      }
      if (!foundProp) return null;

      var objs = objsWithProp(foundProp);
      if (objs) {
        var matches = [];
        search: for (var i = 0; i < objs.length; ++i) {
          var obj = objs[i];
          for (var prop in props) {
            var found = false;
            for (var o = obj; o; o = o.proto) {
              var match = o.props[prop];
              if (match && (match.flags & flag_definite)) { found = true; break; }
            }
            if (!found) continue search;
          }
          matches.push(obj);
        }
        return canonicalType(matches);
      }
    },

    typeHint: function() { return this.types.length ? this.getType() : null; },
    propagatesTo: function() { return this; },

    gatherProperties: function(prefix, out) {
      for (var i = 0; i < this.types.length; ++i)
        this.types[i].gatherProperties(prefix, out);
    }
  };

  function canonicalType(types) {
    var arrays = 0, fns = 0, objs = 0, prim = null;
    for (var i = 0; i < types.length; ++i) {
      var tp = types[i];
      if (tp instanceof Arr) ++arrays;
      else if (tp instanceof Fn) ++fns;
      else if (tp instanceof Obj) ++objs;
      else if (tp instanceof Prim) {
        if (prim && tp.name != prim.name) return null;
        prim = tp;
      }
    }
    var kinds = (arrays && 1) + (fns && 1) + (objs && 1) + (prim && 1);
    if (kinds > 1) return null;
    if (prim) return prim;

    var maxScore = 0, maxTp = null;
    for (var i = 0; i < types.length; ++i) {
      var tp = types[i], score = 0;
      if (arrays) {
        score = tp.getProp("<i>").isEmpty() ? 1 : 2;
      } else if (fns) {
        score = 1;
        for (var j = 0; j < tp.args.length; ++j) if (!tp.args[j].isEmpty()) ++score;
        if (!tp.retval.isEmpty()) ++score;
      } else if (objs) {
        score = tp.name ? 100 : 1;
        // FIXME this heuristic is far-fetched.
        for (var prop in tp.props) if (hop(tp.props, prop) && tp.props[prop].flags & flag_definite) ++score;
        for (var o = tp; o; o = o.proto) if (o.provisionary) {
          score = 1;
          break;
        }
      } else if (prims) {
        score = 1;
      }
      if (score > maxScore) { maxScore = score; maxTp = tp; }
    }
    return maxTp;
  }

  // A variant of AVal used for unknown, dead-end values
  var ANull = exports.ANull = {
    addType: function() {},
    propagate: function() {},
    getProp: function() { return ANull; },
    forAllProps: function() {},
    hasType: function() { return false; },
    isEmpty: function() { return true; },
    getFunctionType: function() {},
    getType: function() {},
    gatherProperties: function() {}
  };

  // PROPAGATION STRATEGIES

  function PropIsSubset(prop, target) {
    this.target = target; this.prop = prop;
  }
  PropIsSubset.prototype = {
    addType: function(type) {
      if (type.getProp)
        type.getProp(this.prop).propagate(this.target);
    },
    propHint: function() { return this.prop; },
    propagatesTo: function() {
      return {target: this.target, pathExt: "." + this.prop};
    }
  };

  function PropHasSubset(prop, target) {
    this.target = target; this.prop = prop;
  }
  PropHasSubset.prototype = {
    addType: function(type) {
      if (type.ensureProp)
        this.target.propagate(type.ensureProp(this.prop));
    },
    propHint: function() { return this.prop; }
  };

  function ForAllProps(c) { this.c = c; }
  ForAllProps.prototype.addType = function(type) {
    if (!(type instanceof Obj)) return;
    type.forAllProps(this.c);
  };

  var IsCallee = exports.IsCallee = function(self, args, argNodes, retval) {
    this.self = self; this.args = args; this.argNodes = argNodes; this.retval = retval || ANull;
  }
  IsCallee.prototype = {
    addType: function(fn) {
      if (!(fn instanceof Fn)) return;
      if (!fn.args) console.log("escaped: ", fn.info);
      for (var i = 0, e = Math.min(this.args.length, fn.args.length); i < e; ++i)
        this.args[i].propagate(fn.args[i]);
      this.self.propagate(fn.self);
      if (fn.computeRet)
        fn.computeRet(this.self, this.args, this.argNodes).propagate(this.retval);
      else
        fn.retval.propagate(this.retval);
    },
    typeHint: function() {
      var names = [];
      for (var i = 0; i < this.args.length; ++i) names.push("?");
      return new Fn(null, this.self, this.args, names, this.retval);
    }
  };

  function IfObjType(other) { this.other = other; }
  IfObjType.prototype.addType = function(obj) {
    if (obj instanceof Obj) this.other.addType(obj);
  };

  function HasMethodCall(propName, args, argNodes, retval) {
    this.propName = propName; this.args = args; this.argNodes = argNodes; this.retval = retval;
  }
  HasMethodCall.prototype.addType = function(obj) {
    obj.getProp(this.propName).propagate(new IsCallee(obj, this.args, this.argNodes, this.retval));
  };
  HasMethodCall.prototype.propHint = function() { return this.propName; };

  function IsCtor(target) { this.target = target; }
  IsCtor.prototype.addType = function(f) {
    if (!(f instanceof Fn)) return;
    f.getProp("prototype").propagate(new IsProto(f, this.target));
  };

  function IsProto(ctor, target) { this.ctor = ctor; this.target = target; }
  IsProto.prototype.addType = function(o) {
    if (!(o instanceof Obj)) return;

    if (!o.instances) o.instances = [];
    for (var i = 0; i < o.instances.length; ++i) {
      var cur = o.instances[i];
      if (cur.ctor == this.ctor) return this.target.addType(cur.instance);
    }
    var instance = new Obj(o);
    o.instances.push({ctor: this.ctor, instance: instance});
    this.target.addType(instance);
  };

  function IsAdded(other, target) {
    this.other = other; this.target = target;
  }
  IsAdded.prototype = {
    addType: function(type) {
      if (type == cx.str)
        this.target.addType(cx.str);
      else if (type == cx.num && this.other.hasType(cx.num))
        this.target.addType(cx.num);
    },
    typeHint: function() { return this.other; }
  };

  // TYPE OBJECTS

  var Type = exports.Type = function() {};
  Type.prototype = {
    propagate: function(c) { c.addType(this); },
    hasType: function(other) { return other == this; },
    isEmpty: function() { return false; },
    typeHint: function() { return this; },
    getFunctionType: function() {},
    getType: function() { return this; },
    addType: function() {},
    forAllProps: function() {}
  };

  var Prim = exports.Prim = function(proto, name) { this.name = name; this.proto = proto; };
  Prim.prototype = Object.create(Type.prototype);
  Prim.prototype.toString = function() { return this.name; };
  Prim.prototype.getProp = function(prop) {return this.proto.props[prop] || ANull;};
  Prim.prototype.gatherProperties = function(prefix, out) {
    if (this.proto) this.proto.gatherProperties(prefix, out);
  };

  function hop(obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
  }

  var flag_initializer = exports.flag_initializer = 1;
  var flag_definite = exports.flag_definite = 2;

  var Obj = exports.Obj = function(proto, name, origin) {
    if (!this.props) this.props = Object.create(null);
    this.proto = proto === true ? cx.protos.Object : proto;
    if (proto && !name && proto.name && !(this instanceof Fn)) {
      var match = /^(.*)\.prototype$/.exec(this.proto.name);
      this.name = match ? match[1] : proto.name;
    } else {
      this.name = name;
    }
    if (origin !== false) this.setOrigin(origin);

    if (this.proto && !this.prev) this.proto.forAllProps(this.onProtoProp.bind(this));
    return this;
  };
  Obj.prototype = Object.create(Type.prototype);
  Obj.prototype.toString = function(maxDepth) {
    if (!maxDepth && this.name) return this.name;
    var props = [];
    for (var prop in this.props) if (prop != "<i>" && this.props[prop].flags & flag_definite) {
      if (maxDepth)
        props.push(prop + ": " + toString(this.props[prop].getType(), maxDepth - 1));
      else if (this.props[prop].flags & flag_initializer)
        props.push(prop);
    }
    props.sort();
    return "{" + props.join(", ") + "}";
  };
  Obj.prototype.ensureProp = function(prop, alsoProto) {
    var found = this.props[prop];
    if (alsoProto) for (var p = this.proto; p && !found; p = p.proto) found = p.props[prop];
    if (found) {
      if (!alsoProto && !(found.flags & flag_definite)) {
        found.flags |= flag_definite;
        this.broadcastProp(prop, found, true);
      }
      return found;
    }

    var av = new AVal;
    if (prop == "__proto__" || prop == "✖") return av;

    this.props[prop] = av;
    if (!alsoProto) {
      av.flags |= flag_definite;
      this.broadcastProp(prop, av, true);
    }
    return av;
  };
  Obj.prototype.getProp = function(prop) {
    return this.ensureProp(prop, true);
  };
  Obj.prototype.broadcastProp = function(prop, val, local) {
    // If this is a scope, it shouldn't be registered
    if (local && !this.prev) registerProp(prop, this);

    if (this.onNewProp) for (var i = 0; i < this.onNewProp.length; ++i)
      this.onNewProp[i](prop, val, local);
  };
  Obj.prototype.onProtoProp = function(prop, val, local) {
    var val = this.props[prop];
    if (val) {
      if (val.flags & flag_definite) return;
      delete this.props[prop];
      this.proto.getProp(prop).propagate(val);
    } else {
      this.broadcastProp(prop, val, false);
    }
  };
  Obj.prototype.gatherProperties = function(prefix, out) {
    // 'hasOwnProperty' and such are usually just noise, leave them
    // out when no prefix is provided.
    if (this == cx.protos.Object && !prefix) return;

    for (var prop in this.props) {
      if (prefix && prop.indexOf(prefix) != 0 || prop == "<i>") continue;
      var val = this.props[prop];
      if (!(val.flags & flag_definite) || out.indexOf(prop) > -1) continue;
      out.push(prop);
    }
    if (this.proto) this.proto.gatherProperties(prefix, out);
  };
  Obj.prototype.forAllProps = function(c) {
    (this.onNewProp || (this.onNewProp = [])).push(c);
    for (var o = this; o; o = o.proto) {
      for (var prop in o.props) {
        var val = o.props[prop];
        if (val.flags & flag_definite) c(prop, val, o == this);
      }
    }
  };

  Obj.prototype.setOrigin = function(orig) {
    if (orig || (orig = cx.curOrigin)) this.origin = orig;
  };

  // FIXME this is too easily confused. Use types again (or give up on it entirely?)
  Obj.findByProps = function(props) {
    if (!props.length) return null;
    var types = objsWithProp(props[0].key.name);
    if (types) outer: for (var i = 0; i < types.length; ++i) {
      var type = types[i], matching = 0;
      for (var p in type.props) {
        var prop = type.props[p];
        if (prop.flags & flag_initializer) {
          if (!props.some(function(x) {return x.key.name == p;})) continue outer;
          ++matching;
        }
      }
      if (matching == props.length) return type;
    }
  };

  var Fn = exports.Fn = function(name, self, args, argNames, retval) {
    Obj.call(this, cx.protos.Function, name, false);
    this.self = self;
    this.args = args;
    this.argNames = argNames;
    this.retval = retval;
    this.setOrigin();
    return this;
  };
  Fn.prototype = Object.create(Obj.prototype);
  Fn.prototype.toString = function(maxDepth) {
    if (maxDepth) maxDepth--;
    var str = "fn(";
    for (var i = 0; i < this.args.length; ++i) {
      if (i) str += ", ";
      var name = this.argNames[i];
      if (name && name != "?") str += name + ": ";
      str += toString(this.args[i].getType(), maxDepth);
    }
    str += ")";
    if (!this.retval.isEmpty())
      str += " -> " + toString(this.retval.getType(), maxDepth);
    return str;
  };
  Fn.prototype.ensureProp = function(prop, alsoProto) {
    var newProto = prop == "prototype" && !("prototype" in this.props);
    var retval = Obj.prototype.ensureProp.call(this, prop, alsoProto && !newProto);
    if (newProto) {
      if (this.name) {
        name = this.name + ".prototype";
        retval.propagate({addType: function(t) {if (!t.name) t.name = name;}});
      }
      if (retval.isEmpty() && alsoProto) {
        var proto = new Obj(true);
        proto.provisionary = true;
        retval.addType(proto);
      }
    }
    return retval;
  };
  Fn.prototype.getFunctionType = function() { return this; };

  var Arr = exports.Arr = function(contentType) {
    Obj.call(this, cx.protos.Array, false);
    var content = this.ensureProp("<i>");
    if (contentType) contentType.propagate(content);
    return this;
  };
  Arr.prototype = Object.create(Obj.prototype);
  Arr.prototype.toString = function(maxDepth) {
    if (maxDepth) maxDepth--;
    return "[" + toString(this.getProp("<i>").getType(), maxDepth) + "]";
  };

  // THE PROPERTY REGISTRY

  function registerProp(prop, obj) {
    var data = cx.props[prop] || (cx.props[prop] = []);
    data.push(obj);
  }

  function objsWithProp(prop) {
    return cx.props[prop];
  }

  // INFERENCE CONTEXT

  var Context = exports.Context = function(environment, parent) {
    this.parent = parent;
    this.props = Object.create(null);
    this.protos = Object.create(null);
    this.prim = Object.create(null);
    this.origins = [];
    this.curOrigin = "ecma5";
    this.paths = Object.create(null);

    exports.withContext(this, function() {
      this.curOrigin = "ecma5";
      cx.protos.Object = new Obj(null, "Object.prototype");
      cx.topScope = new Scope();
      cx.protos.Array = new Obj(true, "Array.prototype");
      cx.protos.Function = new Obj(true, "Function.prototype");
      cx.protos.RegExp = new Obj(true, "RegExp.prototype");
      cx.protos.String = new Obj(true, "String.prototype");
      cx.protos.Number = new Obj(true, "Number.prototype");
      cx.protos.Boolean = new Obj(true, "Boolean.prototype");
      cx.str = new Prim(cx.protos.String, "string");
      cx.bool = new Prim(cx.protos.Boolean, "bool");
      cx.num = new Prim(cx.protos.Number, "number");
      this.curOrigin = null;

      if (environment) for (var i = 0; i < environment.length; ++i)
        loadEnvironment(environment[i]);
    });
  };

  var cx = null;
  exports.cx = function() { return cx; };

  exports.withContext = function(context, f) {
    var old = cx;
    cx = context || new Context("browser");
    try { return f(); }
    finally { cx = old; }
  };

  function addOrigin(origin) {
    if (cx.origins.indexOf(origin) < 0) cx.origins.push(origin);
  }

  // SCOPES

  function Scope(prev) {
    this.prev = prev;
    Obj.call(this, prev || true);
  }
  Scope.prototype = Object.create(Obj.prototype);
  Scope.prototype.getVar = function(name, define) {
    for (var s = this; ; s = s.proto) {
      var found = s.props[name];
      if (found) return found;
      if (s == cx.topScope) return s.ensureProp(name, !define);
    }
  };
  Scope.prototype.defVar = function(name) { return this.getVar(name, true); };
  Scope.prototype.findVar = function(name) {
    for (var s = this; s; s = s.proto) {
      var found = s.props[name];
      if (found) return found;
    }
  };

  function maybeTypeManipulator(scope, score) {
    if (!scope.typeManipScore) scope.typeManipScore = 0;
    scope.typeManipScore += score;
  }

  function maybeTagAsTypeManipulator(node, scope) {
    if (scope.typeManipScore && scope.typeManipScore / (node.end - node.start) > .01) {
      var fn = scope.fnType;
      // Disconnect the arg avals, so that we can add info to them without side effects
      for (var i = 0; i < fn.args.length; ++i) fn.args[i] = new AVal;
      fn.self = new AVal;
      var computeRet = fn.computeRet = function(self, args) {
        // Prevent recursion
        this.computeRet = null;
        var scopeCopy = new Scope(scope.prev);
        for (var v in scope.props) {
          var local = scopeCopy.ensureProp(v);
          for (var i = 0; i < fn.argNames.length; ++i) if (fn.argNames[i] == v && i < args.length)
            args[i].propagate(local);
        }
        scopeCopy.fnType = new Fn(fn.name, self, args, fn.argNames, new AVal);
        node.body.scope = scopeCopy;
        walk.recursive(node.body, scopeCopy, null, scopeGatherer);
        walk.recursive(node.body, scopeCopy, null, inferWrapper);
        this.computeRet = computeRet;
        return scopeCopy.fnType.retval;
      };
      return true;
    }
  }

  function maybeTagAsGeneric(node, fn) {
    var target = fn.retval, targetInner, asArray;
    if (!target.isEmpty() && (targetInner = target.getType()) instanceof Arr)
      target = asArray = targetInner.getProp("<i>");
    if (!target.isEmpty()) return;

    function explore(aval, path, depth) {
      if (depth > 6 || !aval.forward) return;
      for (var i = 0; i < aval.forward.length; ++i) {
        var fw = aval.forward[i], prop = fw.propagatesTo && fw.propagatesTo();
        if (!prop) continue;
        var newPath = path, dest;
        if (prop instanceof AVal) {
          dest = prop;
        } else if (prop.target instanceof AVal) {
          newPath += prop.pathExt;
          dest = prop.target;
        } else continue;
        if (dest == target) throw {foundPath: newPath};
        explore(dest, newPath, depth + 1);
      }
    }

    var foundPath;
    try {
      explore(fn.self, "$this", 0);
      for (var i = 0; i < fn.args.length; ++i)
        explore(fn.args[i], "$" + i, 0);
    } catch (e) {
      if (!(foundPath = e.foundPath)) throw e;
    }

    if (foundPath) {
      if (asArray) foundPath = "[" + foundPath + "]";
      var p = new TypeParser(foundPath);
      fn.computeRet = p.parseRetType();
      fn.computeRetSource = foundPath;
      return true;
    }
  }

  // SCOPE GATHERING PASS

  function addVar(scope, name) {
    var val = scope.ensureProp(name.name);
    val.name = name;
    val.origin = cx.curOrigin;
    return val;
  }

  var scopeGatherer = walk.make({
    Function: function(node, scope, c) {
      var inner = node.body.scope = new Scope(scope);
      var argVals = [], argNames = [];
      for (var i = 0; i < node.params.length; ++i) {
        var param = node.params[i];
        argNames.push(param.name);
        argVals.push(addVar(inner, param));
      }
      inner.fnType = new Fn(node.id && node.id.name, new AVal, argVals, argNames, new AVal);
      inner.fnType.originNode = node;
      if (node.id) {
        var decl = node.type == "FunctionDeclaration";
        addVar(decl ? scope : inner, node.id);
      }
      c(node.body, inner, "ScopeBody");
    },
    TryStatement: function(node, scope, c) {
      c(node.block, scope, "Statement");
      for (var i = 0; i < node.handlers.length; ++i) {
        var handler = node.handlers[i], name = handler.param.name;
        addVar(scope, handler.param);
        c(handler.body, scope, "ScopeBody");
      }
      if (node.finalizer) c(node.finalizer, scope, "Statement");
    },
    VariableDeclaration: function(node, scope, c) {
      for (var i = 0; i < node.declarations.length; ++i) {
        var decl = node.declarations[i];
        addVar(scope, decl.id);
        if (decl.init) c(decl.init, scope, "Expression");
      }
    }
  });

  // CONSTRAINT GATHERING PASS

  function propName(node, scope, c) {
    var prop = node.property;
    if (!node.computed) return prop.name;
    if (prop.type == "Literal" && typeof prop.value == "string") return prop.value;
    if (c) infer(prop, scope, c, ANull);
    return "<i>";
  }

  function lvalName(node) {
    if (node.type == "Identifier") return node.name;
    if (node.type == "MemberExpression" && !node.computed) {
      if (node.object.type != "Identifier") return node.property.name;
      return node.object.name + "." + node.property.name;
    }
  }

  function getInstance(obj) {
    return obj.instance || (obj.instance = new Obj(obj));
  }

  function unopResultType(op) {
    switch (op) {
    case "+": case "-": case "~": return cx.num;
    case "!": return cx.bool;
    case "typeof": return cx.str;
    case "void": case "delete": return ANull;
    }
  }
  function binopIsBoolean(op) {
    switch (op) {
    case "==": case "!=": case "===": case "!==": case "<": case ">": case ">=": case "<=":
    case "in": case "instanceof": return true;
    }
  }
  function literalType(val) {
    switch (typeof val) {
    case "boolean": return cx.bool;
    case "number": return cx.num;
    case "string": return cx.str;
    case "object":
      if (!val) return ANull;
      return getInstance(cx.protos.RegExp);
    }
  }

  function join(a, b) {
    if (a == b) return a;
    var joined = new AVal;
    a.propagate(joined); b.propagate(joined);
    return joined;
  }

  function ret(f) {
    return function(node, scope, c, out, name) {
      var r = f(node, scope, c, name);
      if (out) r.propagate(out);
      return r;
    };
  }
  function fill(f) {
    return function(node, scope, c, out, name) {
      if (!out) out = new AVal;
      f(node, scope, c, out, name);
      return out;
    };
  }

  var inferExprVisitor = {
    ArrayExpression: ret(function(node, scope, c) {
      var eltval = new AVal;
      for (var i = 0; i < node.elements.length; ++i) {
        var elt = node.elements[i];
        if (elt) infer(elt, scope, c, eltval);
      }
      return new Arr(eltval);
    }),
    ObjectExpression: ret(function(node, scope, c, name) {
      var obj = Obj.findByProps(node.properties);
      if (!obj) {
        obj = new Obj(true, name);
        obj.originNode = node;
      }

      for (var i = 0; i < node.properties.length; ++i) {
        var prop = node.properties[i], val = obj.ensureProp(prop.key.name);
        val.flags |= flag_initializer;
        infer(prop.value, scope, c, val, prop.key.name);
      }
      return obj;
    }),
    FunctionExpression: ret(function(node, scope, c, name) {
      var inner = node.body.scope, fn = inner.fnType;
      if (name && !fn.name) fn.name = name;
      c(node.body, scope, "ScopeBody");
      maybeTagAsTypeManipulator(node, inner) || maybeTagAsGeneric(node, inner.fnType);
      if (node.id) inner.defVar(node.id.name).addType(fn);
      return fn;
    }),
    SequenceExpression: ret(function(node, scope, c) {
      for (var i = 0, l = node.expressions.length - 1; i < l; ++i)
        infer(node.expressions[i], scope, c, ANull);
      return infer(node.expressions[l], scope, c);
    }),
    UnaryExpression: ret(function(node, scope, c) {
      infer(node.argument, scope, c, ANull);
      return unopResultType(node.operator);
    }),
    UpdateExpression: ret(function(node, scope, c) {
      infer(node.argument, scope, c, ANull);
      return cx.num;
    }),
    BinaryExpression: ret(function(node, scope, c) {
      if (node.operator == "+") {
        var lhs = infer(node.left, scope, c);
        var rhs = infer(node.right, scope, c);
        if (lhs.hasType(cx.str) || rhs.hasType(cx.str)) return cx.str;
        if (lhs.hasType(cx.num) && rhs.hasType(cx.num)) return cx.num;
        var result = new AVal;
        lhs.propagate(new IsAdded(rhs, result));
        rhs.propagate(new IsAdded(lhs, result));
        return result;
      } else {
        infer(node.left, scope, c, ANull);
        infer(node.right, scope, c, ANull);
        return binopIsBoolean(node.operator) ? cx.bool : cx.num;
      }
    }),
    AssignmentExpression: ret(function(node, scope, c) {
      var rhs, name, pName;
      if (node.left.type == "MemberExpression") {
        pName = propName(node.left, scope, c);
        if (node.left.object.type == "Identifier")
          name = node.left.object.name + "." + pName;
      } else {
        name = node.left.name;
      }

      if (node.operator != "=" && node.operator != "+=") {
        infer(node.right, scope, c, ANull, name);
        rhs = cx.num;
      } else {
        rhs = infer(node.right, scope, c, null, name);
      }

      if (node.left.type == "MemberExpression") {
        var obj = infer(node.left.object, scope, c);
        if (pName == "prototype") maybeTypeManipulator(scope, 20);
        if (pName == "<i>") {
          // This is a hack to recognize for/in loops that copy
          // properties, and do the copying ourselves, insofar as we
          // manage, because such loops tend to be relevant for type
          // information.
          var v = node.left.property.name, local = scope.props[v], over = local && local.iteratesOver;
          if (over) {
            var fromRight = node.right.type == "MemberExpression" && node.right.computed && node.right.property.name == v;
            over.forAllProps(function(prop, val, local) {
              if (local && prop != "prototype" && prop != "<i>")
                obj.propagate(new PropHasSubset(prop, fromRight ? val : ANull));
            });
            return rhs;
          }
        }
        obj.propagate(new PropHasSubset(pName, rhs));
      } else { // Identifier
        rhs.propagate(scope.defVar(node.left.name));
      }
      return rhs;
    }),
    LogicalExpression: fill(function(node, scope, c, out) {
      infer(node.left, scope, c, out);
      infer(node.right, scope, c, out);
    }),
    ConditionalExpression: fill(function(node, scope, c, out) {
      infer(node.test, scope, c, ANull);
      infer(node.consequent, scope, c, out);
      infer(node.alternate, scope, c, out);
    }),
    NewExpression: fill(function(node, scope, c, out) {
      if (node.callee.type == "Identifier" && node.callee.name in scope.props)
        maybeTypeManipulator(scope, 20);

      for (var i = 0, args = []; i < node.arguments.length; ++i)
        args.push(infer(node.arguments[i], scope, c));
      var callee = infer(node.callee, scope, c);
      var self = new AVal;
      callee.propagate(new IsCtor(self));
      callee.propagate(new IsCallee(self, args, node.arguments, out));
      self.propagate(out);
    }),
    CallExpression: fill(function(node, scope, c, out) {
      for (var i = 0, args = []; i < node.arguments.length; ++i)
        args.push(infer(node.arguments[i], scope, c));
      if (node.callee.type == "MemberExpression") {
        var self = infer(node.callee.object, scope, c);
        self.propagate(new HasMethodCall(propName(node.callee, scope, c), args, node.arguments, out));
      } else {
        var callee = infer(node.callee, scope, c);
        callee.propagate(new IsCallee(cx.topScope, args, node.arguments, out));
      }
    }),
    MemberExpression: ret(function(node, scope, c) {
      return infer(node.object, scope, c).getProp(propName(node, scope, c));
    }),
    Identifier: ret(function(node, scope) {
      if (node.name == "arguments" && !(node.name in scope.props))
        scope.ensureProp(node.name).addType(new Arr);
      return scope.getVar(node.name);
    }),
    ThisExpression: ret(function(node, scope) {
      return scope.fnType ? scope.fnType.self : cx.topScope;
    }),
    Literal: ret(function(node, scope) {
      return literalType(node.value);
    })
  };

  function infer(node, scope, c, out, name) {
    return inferExprVisitor[node.type](node, scope, c, out, name);
  }

  var inferWrapper = walk.make({
    Expression: function(node, scope, c) {
      infer(node, scope, c, ANull);
    },
    
    FunctionDeclaration: function(node, scope, c) {
      var inner = node.body.scope, fn = inner.fnType;
      c(node.body, scope, "ScopeBody");
      maybeTagAsTypeManipulator(node, inner) || maybeTagAsGeneric(node, inner.fnType);
      scope.defVar(node.id.name).addType(fn);
    },

    VariableDeclaration: function(node, scope, c) {
      for (var i = 0; i < node.declarations.length; ++i) {
        var decl = node.declarations[i];
        if (decl.init)
          infer(decl.init, scope, c, scope.defVar(decl.id.name), decl.id.name);
      }
    },

    ReturnStatement: function(node, scope, c) {
      if (node.argument && scope.fnType)
        infer(node.argument, scope, c, scope.fnType.retval);
    },

    ForInStatement: function(node, scope, c) {
      var source = infer(node.right, scope, c);
      if ((node.right.type == "Identifier" && node.right.name in scope.props) ||
          (node.right.type == "MemberExpression" && node.right.property.name == "prototype")) {
        maybeTypeManipulator(scope, 5);
        var varName;
        if (node.left.type == "Identifier") {
          varName = node.left.name;
        } else if (node.left.type == "VariableDeclaration") {
          varName = node.left.declarations[0].id.name;
        }
        if (varName && varName in scope.props)
          scope.getVar(varName).iteratesOver = source;
      }
      c(node.body, scope, "Statement");
    },

    ScopeBody: function(node, scope, c) { c(node, node.scope || scope); }
  });

  exports.analyze = function(text, file, scope) {
    if (!file) file = "file#" + cx.origins.length;
    addOrigin(cx.curOrigin = file);

    var jsDoc = [], options = {onComment: gatherJSDoc(jsDoc)};
    var ast = acorn.parse_dammit(text, options);

    if (!scope) scope = cx.topScope;
    walk.recursive(ast, scope, null, scopeGatherer);
    walk.recursive(ast, scope, null, inferWrapper);
    for (var i = 0; i < jsDoc.length; ++i)
      applyJSDocType(jsDoc[i], ast, scope);
    cx.curOrigin = null;
    return {ast: ast, text: text, file: file};
  };

  // EXPRESSION TYPE DETERMINATION

  function findByPropertyName(name) {
    guessing = true;
    var found = objsWithProp(name);
    if (found) for (var i = 0; i < found.length; ++i) {
      var val = found[i].getProp(name);
      if (!val.isEmpty()) return val;
    }
    return ANull;
  }

  var typeFinder = {
    ArrayExpression: function(node, scope) {
      var eltval = new AVal;
      for (var i = 0; i < node.elements.length; ++i) {
        var elt = node.elements[i];
        if (elt) findType(elt, scope).propagate(eltval);
      }
      return new Arr(eltval);
    },
    ObjectExpression: function(node, scope) {
      if (node.properties.length) return Obj.findByProps(node.properties);
      else return new Obj(true);
    },
    FunctionExpression: function(node) {
      return node.body.scope.fnType;
    },
    SequenceExpression: function(node, scope) {
      return findType(node.expressions[node.expressions.length-1], scope);
    },
    UnaryExpression: function(node) {
      return unopResultType(node.operator);
    },
    UpdateExpression: function() {
      return cx.num;
    },
    BinaryExpression: function(node, scope) {
      if (binopIsBoolean(node.operator)) return cx.bool;
      if (node.operator == "+") {
        var lhs = findType(node.left, scope);
        var rhs = findType(node.right, scope);
        if (lhs.hasType(cx.str) || rhs.hasType(cx.str)) return cx.str;
      }
      return cx.num;
    },
    AssignmentExpression: function(node, scope) {
      return findType(node.right, scope);
    },
    LogicalExpression: function(node, scope) {
      var lhs = findType(node.left, scope);
      return lhs.isEmpty() ? findType(node.right, scope) : lhs;
    },
    ConditionalExpression: function(node, scope) {
      var lhs = findType(node.consequent, scope);
      return lhs.isEmpty() ? findType(node.alternate, scope) : lhs;
    },
    // FIXME this doesn't work, for some reason
    NewExpression: function(node, scope) {
      var f = findType(node.callee, scope).getFunctionType();
      var proto = f && f.getProp("prototype").getType();
      if (!proto) return ANull;
      if (proto.instances) return proto.instances[0].instance;
      else return proto;
    },
    CallExpression: function(node, scope) {
      var f = findType(node.callee, scope).getFunctionType();
      if (!f) return ANull;
      if (f.computeRet) {
        for (var i = 0, args = []; i < node.arguments.length; ++i)
          args.push(findType(node.arguments[i], scope));
        var self = ANull;
        if (node.callee.type == "MemberExpression")
          self = findType(node.callee.object, scope);
        return f.computeRet(self, args, node.arguments);
      } else {
        return f.retval;
      }
    },
    MemberExpression: function(node, scope) {
      var propN = propName(node, scope);
      var prop = findType(node.object, scope).getProp(propN);
      return prop.isEmpty() && propN != "<i>" ? findByPropertyName(propN) : prop;
    },
    Identifier: function(node, scope) {
      return scope.findVar(node.name) || ANull;
    },
    ThisExpression: function(node, scope) {
      return scope.fnType ? scope.fnType.self : cx.topScope;
    },
    Literal: function(node) {
      return literalType(node.value);
    }
  };

  function findType(node, scope) {
    var found = typeFinder[node.type](node, scope);
    if (found.isEmpty()) found = found.getType() || found;
    return found;
  }

  var searchVisitor = walk.make({
    Function: function(node, st, c) {
      var scope = node.body.scope;
      if (node.id) c(node.id, scope);
      for (var i = 0; i < node.params.length; ++i)
        c(node.params[i], scope);
      c(node.body, scope, "ScopeBody");
    },
    TryStatement: function(node, st, c) {
      for (var i = 0; i < node.handlers.length; ++i)
        c(node.handlers[i].param, st);
      walk.base.TryStatement(node, st, c);
    },
    VariableDeclaration: function(node, st, c) {
      for (var i = 0; i < node.declarations.length; ++i) {
        var decl = node.declarations[i];
        c(decl.id, st);
        if (decl.init) c(decl.init, st, "Expression");
      }
    }
  });

  exports.findExpressionAt = function(ast, start, end, defaultScope) {
    var test = function(_t, node) {return typeFinder.hasOwnProperty(node.type);};
    return walk.findNodeAt(ast, start, end, test, searchVisitor, defaultScope || cx.topScope);
  };

  exports.findExpressionAround = function(ast, start, end, defaultScope) {
    var test = function(_t, node) {
      if (start != null && node.start > start) return false;
      return typeFinder.hasOwnProperty(node.type);
    };
    return walk.findNodeAround(ast, end, test, searchVisitor, defaultScope || cx.topScope);
  };

  exports.expressionType = function(found) {
    return findType(found.node, found.state);
  };

  // Flag used to indicate that some wild guessing was used to produce
  // a type or set of completions.
  var guessing = false;

  exports.resetGuessing = function() { guessing = false; };
  exports.didGuess = function() { return guessing; };

  function compareProps(a, b) {
    var aUp = /^[A-Z]/.test(a), bUp = /^[A-Z]/.test(b);
    if (aUp == bUp) return a < b ? -1 : a == b ? 0 : 1;
    else return aUp ? 1 : -1;
  }

  exports.propertiesOf = function(type, prefix) {
    var props = [];
    type.gatherProperties(prefix, props);
    if (!props.length && prefix.length >= 2) {
      guessing = true;
      for (var prop in cx.props) if (prop.indexOf(prefix) == 0) props.push(prop);
    }
    props.sort(compareProps);
    return props;
  };

  var refFindWalker = walk.make({}, searchVisitor);

  exports.findRefs = function(ast, name, scope, f) {
    refFindWalker.Identifier = function(node, sc) {
      if (node.name != name) return;
      for (; sc; sc = sc.prev) {
        if (sc == scope) f(node);
        if (name in sc.props) return;
      }
    };
    walk.recursive(ast, cx.topScope, null, refFindWalker);
  };

  // LOCAL-VARIABLE QUERIES

  var scopeAt = exports.scopeAt = function(ast, pos, defaultScope) {
    var found = walk.findNodeAround(ast, pos, "ScopeBody");
    if (found) return found.node.scope;
    else return defaultScope || cx.topScope;
  };

  exports.localsAt = function(ast, pos, prefix) {
    var scope = scopeAt(ast, pos), locals = [];
    scope.gatherProperties(prefix, locals);
    locals.sort(compareProps);
    return locals;
  };

  // CONTEXT POPULATING

  function TypeParser(spec, start, base) {
    this.pos = start || 0; this.spec = spec; this.base = base;
  }
  TypeParser.prototype = {
    eat: function(str) {
      if (str.length == 1 ? this.spec.charAt(this.pos) == str : this.spec.indexOf(str, this.pos) == this.pos) {
        this.pos += str.length;
        return true;
      }
    },
    word: function(re) {
      var word = "", ch, re = re || /[\w$]/;
      while ((ch = this.spec.charAt(this.pos)) && re.test(ch)) { word += ch; ++this.pos; }
      return word;
    },
    error: function() {
      throw new Error("Unrecognized type spec: " + this.spec + " (at " + this.pos + ")");
    },
    parseFnType: function(name, top) {
      var args = [], names = [];
      if (!this.eat(")")) for (var i = 0; ; ++i) {
        var colon = this.spec.indexOf(": ", this.pos), argname, aval;
        if (colon != -1) {
          argname = this.spec.slice(this.pos, colon);
          if (/^[$\w?]+$/.test(argname))
            this.pos = colon + 2;
          else
            argname = null;
        }
        names.push(argname);
        args.push(this.parseType());
        if (!this.eat(", ")) {
          this.eat(")") || this.error();
          break;
        }
      }
      var retType, computeRet, fn;
      if (this.eat(" -> ")) {
        if (top && this.spec.indexOf("$", this.pos) > -1) {
          retType = ANull;
          computeRet = this.parseRetType();
        } else retType = this.parseType();
      } else retType = ANull;
      if (top && this.base)
        fn = Fn.call(this.base, name, ANull, args, names, retType);
      else
        fn = new Fn(name, ANull, args, names, retType);
      if (computeRet) fn.computeRet = computeRet;
      return fn;
    },
    parseType: function(name, top) {
      if (this.eat("fn(")) {
        return this.parseFnType(name, top);
      } else if (this.eat("[")) {
        var inner = this.parseType();
        this.eat("]") || this.error();
        if (top && this.base)
          return Arr.call(this.base, inner);
        else
          return new Arr(inner);
      } else if (this.eat("+")) {
        var p = this.word(/[\w$<>\.!]/);
        var base = parsePath(p);
        if (base instanceof Fn) {
          var proto = base.props.prototype;
          if (proto) proto = proto.getType();
          if (proto instanceof Obj) return getInstance(proto);
        }
        if (base instanceof Obj) return getInstance(base);
        else return base;
      } else if (this.eat("?")) {
        return ANull;
      } else {
        var spec = this.word(/[\w$<>\.!]/);
        switch (spec) {
        case "number": return cx.num;
        case "string": return cx.str;
        case "bool": return cx.bool;
        case "<top>": return cx.topScope;
        }
        if (cx.localDefs && spec in cx.localDefs) return cx.localDefs[spec];
        return parsePath(spec);
      }
    },
    parseBaseRetType: function() {
      if (this.eat("[")) {
        var inner = this.parseRetType();
        this.eat("]") || this.error();
        return function(self, args) { return new Arr(inner(self, args)); };
      } else if (this.eat("$")) {
        var arg = this.word(/\d/);
        if (arg) {
          arg = Number(arg);
          return function(self, args) {return args[arg] || ANull;};
        } else if (this.eat("this")) {
          return function(self) {return self;};
        } else if (this.eat("custom:")) {
          var fname = this.word(/[\w$]/);
          return customFunctions[fname] || function() { return ANull; };
        } else this.error();
      }
      var t = this.parseType();
      return function(){return t;};
    },
    extendRetType: function(base) {
      var propName = this.word(/[\w<>$]/) || this.error();
      if (propName == "$ret") return function(self, args) {
        var lhs = base(self, args);
        if (lhs.retval) return lhs.retval;
        var rv = new AVal;
        lhs.propagate(new IsCallee(ANull, [], null, rv));
        return rv;
      };
      return function(self, args) {return base(self, args).getProp(propName);};
    },
    parseRetType: function() {
      var tp = this.parseBaseRetType();
      while (this.eat(".")) tp = this.extendRetType(tp);
      return tp;
    }
  }

  function parseType(spec, name, base) {
    var withCallbacks = /^\*fn\(/.test(spec) && (spec = spec.slice(1));
    var type = new TypeParser(spec, null, base).parseType(name, true);
    if (withCallbacks) for (var i = 0; i < type.args.length; ++i) (function(i) {
      var arg = type.args[i];
      if (arg instanceof Fn) addEffect(type, function(_self, fArgs) {
        var fArg = fArgs[i];
        if (fArg) fArg.propagate(new IsCallee(cx.topScope, arg.args));
      });
    })(i);
    return type;
  }

  function addEffect(fn, handler) {
    var oldCmp = fn.computeRet, rv = fn.retval;
    fn.computeRet = function(self, args) {
      handler(self, args);
      return oldCmp ? oldCmp(self, args) : rv;
    };
  }

  function parseEffect(effect, fn) {
    if (effect.indexOf("propagate ") == 0) {
      var p = new TypeParser(effect, 10);
      var getOrigin = p.parseRetType();
      if (!p.eat(" ")) p.error();
      var getTarget = p.parseRetType();
      addEffect(fn, function(self, args) {
        getOrigin(self, args).propagate(getTarget(self, args));
      });
    } else if (effect.indexOf("call ") == 0) {
      var p = new TypeParser(effect, 5);
      var getCallee = p.parseRetType(), getSelf = null, getArgs = [];
      if (p.eat(" this=")) getSelf = p.parseRetType();
      while (p.eat(" ")) getArgs.push(p.parseRetType());
      addEffect(fn, function(self, args) {
        var callee = getCallee(self, args);
        var slf = getSelf ? getSelf(self, args) : ANull, as = [];
        for (var i = 0; i < getArgs.length; ++i) as.push(getArgs[i](self, args));
        callee.propagate(new IsCallee(slf, as));
      });
    } else if (effect.indexOf("custom ") == 0) {
      var customFunc = customFunctions[effect.slice(7).trim()];
      if (customFunc) addEffect(fn, customFunc);
    } else if (effect.indexOf("copy ") == 0) {
      var p = new TypeParser(effect, 5);
      var getFrom = p.parseRetType();
      p.eat(" ");
      var getTo = p.parseRetType();
      addEffect(fn, function(self, args) {
        var from = getFrom(self, args), to = getTo(self, args);
        from.forAllProps(function(prop, val, local) {
          if (local && prop != "<i>")
            to.propagate(new PropHasSubset(prop, val));
        });
      });
    } else {
      throw new Error("Unknown effect type: " + effect);
    }
  }

  function parsePath(path) {
    var cached = cx.paths[path];
    if (cached != null) return cached;
    cx.paths[path] = ANull;

    var isdate = /^Date.prototype/.test(path);
    var parts = path.split(".");
    var base = cx.topScope;
    for (var i = 0; i < parts.length && base != ANull; ++i) {
      var prop = parts[i];
      if (prop.charAt(0) == "!") {
        if (prop == "!proto") {
          base = (base instanceof Obj && base.proto) || ANull;
        } else {
          var fn = base.getFunctionType();
          if (!fn) {
            base = ANull;
          } else if (prop == "!ret") {
            base = fn.retval.getType() || ANull;
          } else {
            var arg = fn.args[Number(prop.slice(1))];
            base = (arg && arg.getType()) || ANull;
          }
        }
      } else if (base instanceof Obj) {
        var propVal = base.props[prop];
        if (!propVal || !(propVal.flags & flag_definite) || propVal.isEmpty())
          base = ANull;
        else
          base = propVal.types[0];
      }
    }
    cx.paths[path] = base == ANull ? null : base;
    return base;
  }

  function emptyObj(ctor) {
    var empty = Object.create(ctor.prototype);
    empty.props = Object.create(null);
    empty.isShell = true;
    return empty;
  }

  function passOne(base, spec, path) {
    if (!base) {
      var tp = spec["!type"];
      if (tp) {
        if (/^\*?fn\(/.test(tp)) base = emptyObj(Fn);
        else if (tp.charAt(0) == "[") base = emptyObj(Arr);
        else throw new Error("Invalid !type spec: " + tp);
      } else if (spec["!stdProto"]) {
        base = cx.protos[spec["!stdProto"]];
      } else {
        base = emptyObj(Obj);
      }
      base.name = path;
    }
    
    for (var name in spec) if (hop(spec, name) && name.charCodeAt(0) != 33) {
      var inner = spec[name];
      if (typeof inner == "string") continue;
      var prop = base.ensureProp(name);
      passOne(prop.getType(), inner, path ? path + "." + name : name).propagate(prop);
    }
    return base;
  }

  function passTwo(base, spec, path) {
    if (base.isShell) {
      delete base.isShell;
      var tp = spec["!type"];
      if (tp) {
        parseType(tp, path, base);
      } else {
        var proto = spec["!proto"];
        Obj.call(base, proto ? parseType(proto) : true, path);
      }
    }

    var effects = spec["!effects"];
    if (effects && base instanceof Fn) for (var i = 0; i < effects.length; ++i)
      parseEffect(effects[i], base);

    for (var name in spec) if (hop(spec, name) && name.charCodeAt(0) != 33) {
      var inner = spec[name], known = base.ensureProp(name), innerPath = path ? path + "." + name : name;
      if (typeof inner == "string") {
        if (known.getType()) continue;
        parseType(inner, innerPath).propagate(known);
      } else {
        passTwo(known.getType(), inner, innerPath);
      }
    }
  }

  function parseDef(spec, path) {
    var base, tp = spec["!type"];
    if (tp) {
      base = parseType(tp, path);
    } else {
      var proto = spec["!proto"];
      base = new Obj(proto ? parseType(proto) : true, path);
    }
    passTwo(base, spec, path);
    return base;
  }

  function loadEnvironment(data) {
    addOrigin(cx.curOrigin = data["!name"] || "env#" + cx.origins.length);
    cx.loading = data;
    cx.localDefs = Object.create(null);

    passOne(cx.topScope, data);

    var def = data["!define"];
    if (def) for (var name in def)
      cx.localDefs[name] = parseDef(def[name], name);

    passTwo(cx.topScope, data);

    cx.curOrigin = cx.loading = cx.localDefs = null;
  }

  // Used to register custom logic for more involved effect or type
  // computation.
  var customFunctions = Object.create(null);
  exports.registerFunction = function(name, f) { customFunctions[name] = f; };

  exports.registerFunction("Object_create", function(self, args) {
    var result = new AVal;
    if (args[0]) args[0].propagate({addType: function(tp) {
      if (tp.isEmpty()) {
        result.addType(new Obj());
      } else if (tp instanceof Obj) {
        var derived = new Obj(tp), spec = args[1];
        if (spec instanceof AVal) spec = spec.types[0];
        if (spec instanceof Obj) for (var prop in spec.props) {
          var cur = spec.props[prop].types[0];
          var p = derived.ensureProp(prop);
          if (cur && cur instanceof Obj && cur.props.value) {
            var vtp = cur.props.value.getType();
            if (vtp) p.addType(vtp);
          }
        }
        result.addType(derived)
      }
    }});
    return result;
  });

  // JSDOC PARSING

  function gatherJSDoc(out) {
    return function(block, text, _start, end) {
      if (!block || !/^\*/.test(text)) return;
      var decl = /(?:\n|\*)\s*@(type|param|arg(?:ument)?|returns?)\s+(.*)/g, m, found = [];
      while (m = decl.exec(text)) {
        var type = m[1];
        if (/^arg/.test(type)) type = "param";
        if (type == "return") type = "returns";
        found.push(type, m[2]);
      }
      if (found.length) out.push({decls: found, at: end});
    };
  }

  function skipSpace(str, pos) {
    while (/\s/.test(str.charAt(pos))) ++pos;
    return pos;
  }

  function parseJSDocLabelList(scope, str, pos, close) {
    var labels = [], types = [];
    for (var first = true; ; first = false) {
      pos = skipSpace(str, pos);
      if (first && str.charAt(pos) == close) break;
      var colon = str.indexOf(":", pos);
      if (colon < 0) return null;
      var label = str.slice(pos, colon);
      if (!/^[\w$]+$/.test(label)) return null;
      labels.push(label);
      pos = colon + 1;
      var type = parseJSDocType(scope, str, pos);
      if (!type) return null;
      pos = type.end;
      types.push(type.type);
      pos = skipSpace(str, pos);
      var next = str.charAt(pos);
      ++pos;
      if (next == close) break;
      if (next != ",") return null;
    }
    return {labels: labels, types: types, end: pos};
  }

  function parseJSDocType(scope, str, pos) {
    pos = skipSpace(str, pos);
    var type;

    if (str.indexOf("function(", pos) == pos) {
      var args = parseJSDocLabelList(scope, str, pos + 9, ")"), ret = ANull;
      if (!args) return null;
      pos = skipSpace(str, args.end);
      if (str.charAt(pos) == ":") {
        ++pos;
        var retType = parseJSDocType(scope, str, pos + 1);
        if (!retType) return null;
        pos = retType.end;
        ret = retType.type;
      }
      type = new Fn(null, ANull, args.labels, args.types, ret);
    } else if (str.charAt(pos) == "[") {
      var inner = parseJSDocType(scope, str, pos + 1);
      if (!inner) return null;
      pos = skipSpace(str, inner.end);
      if (str.charAt(pos) != "]") return null;
      ++pos;
      type = new Arr(inner.type);
    } else if (str.charAt(pos) == "{") {
      var fields = parseJSDocLabelList(scope, str, pos + 1, "}");
      if (!fields) return null;
      type = new Obj(true);
      for (var i = 0; i < fields.types.length; ++i) {
        var field = type.ensureProp(fields.labels[i]);
        field.flags |= flag_initializer;
        fields.types[i].propagate(field);
      }
      pos = fields.end;
    } else {
      var start = pos;
      while (/[\w$]/.test(str.charAt(pos))) ++pos;
      if (start == pos) return null;
      var word = str.slice(start, pos);
      if (/^(number|integer)$/i.test(word)) type = cx.num;
      else if (/^bool(ean)?$/i.test(word)) type = cx.bool;
      else if (/^string$/i.test(word)) type = cx.str;
      else {
        var found = scope.findVar(word);
        if (found) found = found.getType();
        if (!found) {
          type = ANull;
        } else if (found instanceof Fn && /^[A-Z]/.test(word)) {
          var proto = found.getProp("prototype").getType();
          if (proto instanceof Obj) type = getInstance(proto);
        } else {
          type = found;
        }
      }
    }
    return {type: type, end: pos};
  }

  function parseJSDocTypeOuter(scope, str, pos) {
    pos = skipSpace(str, pos || 0);
    if (str.charAt(pos) != "{") return null;
    var result = parseJSDocType(scope, str, pos + 1);
    if (!result || str.charAt(result.end) != "}") return null;
    ++result.end;
    return result;
  }

  function applyJSDocType(annotation, ast, scope) {
    function isDecl(_type, node) { return /^(Variable|Function)Declaration/.test(node.type); }
    var found = walk.findNodeAfter(ast, annotation.at, isDecl, searchVisitor, scope);
    if (!found) return;
    scope = found.state;
    var node = found.node;

    var type, args, ret, decls = annotation.decls;
    for (var i = 0; i < decls.length; i += 2) {
      var parsed = parseJSDocTypeOuter(scope, decls[i + 1]);
      if (!parsed) continue;
      switch (decls[i]) {
      case "returns": ret = parsed.type; break;
      case "type": type = parsed.type; break;
      case "param":
        var name = decls[i + 1].slice(parsed.end).match(/^\s*([\w$]+)/);
        if (!name) continue;
        (args || (args = {}))[name[1]] = parsed.type;
        break;
      }
    }

    var varName, fn;
    if (node.type == "VariableDeclaration" && node.declarations.length == 1) {
      var decl = node.declarations[0];
      varName = decl.id.name;
      if (decl.init && decl.init.type == "FunctionExpression") fn = decl.init.body.scope.fnType;
    } else if (node.type == "FunctionDeclaration") {
      varName = node.id.name;
      fn = node.body.scope.fnType;
    } else {
      return;
    }

    if (fn && (args || ret)) {
      if (args) for (var i = 0; i < fn.argNames.length; ++i) {
        var name = fn.argNames[i], known = args[name];
        if (known) known.propagate(fn.args[i]);
      }
      if (ret) ret.propagate(fn.retval);
    } else if (type) {
      type.propagate(scope.findVar(varName));
    }
  }

})(typeof exports == "undefined" ? window.tern || (window.tern = {}) : exports);
