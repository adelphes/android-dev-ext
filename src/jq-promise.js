// a very stripped down polyfill implementation of jQuery's promise methods
const util = require('util');   // for util.inspect
var $ = this;

// Deferred wraps a Promise into a jQuery-like object
var Deferred = exports.Deferred = function(p, parent) {
    var o = { 
        _isdeferred:true,
        _original:null,
        _promise:null,
        _fns:null,
        _context:null,
        _parent:null,
        _root:null,
        promise() { 
            return this;
        },
        then(fn) {
            var thendef = $.Deferred(null, this);
            var p = this._promise.then(function(a) {
                var res = this.fn.apply(a._ctx, a._args);
                if (res === undefined)
                    return a;
                if (res && res._isdeferred)
                    return res._promise;
                return {_ctx:a._ctx, _args:[res]}
            }.bind({def:thendef,fn:fn}));
            thendef._promise = thendef._original = p;
            return thendef;
        },
        always(fn) {
            var thendef = this.then(fn);
            this.fail(function() {
                // we cannot bind thendef to the function because we need the caller's this to resolve the thendef
                return thendef.resolveWith(this, Array.prototype.map.call(arguments,x=>x))._promise;
            });
            return thendef;
        },
        fail(fn) { 
            var faildef = $.Deferred(null, this);
            var p = this._promise.catch(function(a) {
                if (a.stack) {
                    util.E(a.stack);
                    a = [a];
                }
                if (this.def._context === null && this.def._parent)
                    this.def._context = this.def._parent._context;
                if (this.def._context === null && this.def._root)
                    this.def._context = this.def._root._context;
                var res = this.fn.apply(this.def._context,a);
                if (res === undefined)
                    return a;
                if (res && res._isdeferred)
                    return res._promise;
                return res;
            }.bind({def:faildef,fn:fn}));
            faildef._promise = faildef._original = p;
            return faildef;
        },
        state() {
            var m = util.inspect(this._original).match(/^Promise\s*\{\s*<(\w+)>/);     // urgh!
            // anything that's not pending or rejected is resolved
            return m ? m[1] : 'resolved';
        },
        resolve:function() {
            return this.resolveWith(null, Array.prototype.map.call(arguments,x=>x));
        },
        resolveWith:function(ths, args) {
            if (typeof(args) === 'undefined') args = [];
            if (!Array.isArray(args))
                throw new Error('resolveWith must be passed an array of arguments');
            if (this._root) {
                this._root.resolveWith(ths, args);
                return this;
            }
            if (ths === null || ths === undefined) ths = this;
            this._fns[0]({_ctx:ths,_args:args});
            return this;
        },
        reject:function() {
            return this.rejectWith(null, Array.prototype.map.call(arguments,x=>x));
        },
        rejectWith:function(ths,args) {
            if (typeof(args) === 'undefined') args = [];
            if (!Array.isArray(args))
                throw new Error('rejectWith must be passed an array of arguments');
            if (this._root) {
                this._root.rejectWith(ths, args);
                return this;
            }
            this._context = ths;
            this._fns[1](args);
            return this;
        },
    }
    if (parent) {
        o._original = o._promise = p;
        o._parent = parent;
        o._root = parent._root || parent;
    } else {
        o._original = o._promise = new Promise((res,rej) => {
            o._fns = [res,rej];
        });
    }
    return o;
}

// $.when() is jQuery's version of Promise.all()
// - this version just scans the array of arguments waiting on any Deferreds in turn before finally resolving the return Deferred
var when = exports.when = function() {
    if (arguments.length === 1 && Array.isArray(arguments[0])) {
        return when.apply(this,...arguments).then(() => [...arguments]);
    }
    var x = {
        def: $.Deferred(),
        args: Array.prototype.map.call(arguments,x=>x),
        idx:0,
        next(x) {
            if (x.idx >= x.args.length) {
                return process.nextTick(x => {
                    x.def.resolveWith(null, x.args);
                }, x);
            }
            if ((x.args[x.idx]||{})._isdeferred) {
                x.args[x.idx].then(function() {
                    var x = this, result = Array.prototype.map.call(arguments,x=>x);
                    x.args[x.idx] = result;
                    x.idx++; x.next(x);
                }.bind(x));
                return;
            }
            x.idx++; x.next(x);
        },
    };
    x.next(x);
    return x.def;
}
