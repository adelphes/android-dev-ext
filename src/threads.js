'use strict'

const { AndroidVariables } = require('./variables');
const $ = require('./jq-promise');

/*
    Class used to manage a single thread reported by JDWP
*/
class AndroidThread {
    constructor(session, threadid, vscode_threadid) {
        // the AndroidDebugSession instance
        this.session = session;
        // the Android debugger instance
        this.dbgr = session.dbgr;
        // the java thread id (hex string)
        this.threadid = threadid;
        // the vscode thread id (number)
        this.vscode_threadid = vscode_threadid;
        // the (Java) name of the thread
        this.name = null;
        // the thread break info
        this.paused = null;
        // the timeout during a step which, if it expires, we allow other threads to break
        this.stepTimeout = null;
    }

    threadNotSuspendedError() {
        return new Error(`Thread ${this.vscode_threadid} not suspended`);
    }

    addStackFrameVariable(frame, level) {
        if (!this.paused) throw this.threadNotSuspendedError();
        var frameId = (this.vscode_threadid * 1e9) + (level * 1e6);
        var stack_frame_var = {
            frame, frameId,
            locals: null,
        }
        return this.paused.stack_frame_vars[frameId] = stack_frame_var;
    }

    allocateExceptionScopeReference(frameId) {
        if (!this.paused) return;
        if (!this.paused.last_exception) return;
        this.paused.last_exception.frameId = frameId;
        this.paused.last_exception.scopeRef = frameId + 1;
    }

    getVariables(variablesReference) {
        if (!this.paused)
            return $.Deferred().rejectWith(this, [this.threadNotSuspendedError()]);

        // is this reference a stack frame
        var stack_frame_var = this.paused.stack_frame_vars[variablesReference];
        if (stack_frame_var) {
            // frame locals request
            return this._ensureLocals(stack_frame_var).then(varref => this.paused.stack_frame_vars[varref].locals.getVariables(varref));
        }

        // is this refrence an exception scope
        if (this.paused.last_exception && variablesReference === this.paused.last_exception.scopeRef) {
            var stack_frame_var = this.paused.stack_frame_vars[this.paused.last_exception.frameId];
            return this._ensureLocals(stack_frame_var).then(varref => this.paused.stack_frame_vars[varref].locals.getVariables(this.paused.last_exception.scopeRef));
        }

        // work out which stack frame this reference is for
        var frameId = Math.trunc(variablesReference/1e6) * 1e6;
        var stack_frame_var = this.paused.stack_frame_vars[frameId];

        return stack_frame_var.locals.getVariables(variablesReference);
    }

    _ensureLocals(varinfo) {
        if (!this.paused)
            return $.Deferred().rejectWith(this, [this.threadNotSuspendedError()]);

        // evaluate can call this using frameId as the argument
        if (typeof varinfo === 'number')
            return this._ensureLocals(this.paused.stack_frame_vars[varinfo]);

        // if we're currently processing it (or we've finished), just return the promise
        if (this.paused.locals_done[varinfo.frameId]) 
            return this.paused.locals_done[varinfo.frameId];

        // create a new promise
        var def = this.paused.locals_done[varinfo.frameId] = $.Deferred();

        this.dbgr.getlocals(this.threadid, varinfo.frame, {def:def,varinfo:varinfo})
            .then((locals,x) => {
                // make sure we are still paused...
                if (!this.paused)
                    throw this.threadNotSuspendedError();

                // sort the locals by name, except for 'this' which always goes first
                locals.sort((a,b) => {
                    if (a.name === b.name) return 0;
                    if (a.name === 'this') return -1;
                    if (b.name === 'this') return +1;
                    return a.name.localeCompare(b.name);
                })
                
                // create a new local variable with the results and resolve the promise
                var varinfo = x.varinfo;
                varinfo.cached = locals;
                x.varinfo.locals = new AndroidVariables(this.session, x.varinfo.frameId + 2); // 0 = stack frame, 1 = exception, 2... others
                x.varinfo.locals.setVariable(varinfo.frameId, varinfo);

                var last_exception = this.paused.last_exception;
                if (last_exception) {
                    x.varinfo.locals.setVariable(last_exception.scopeRef, last_exception);
                }

                x.def.resolveWith(this, [varinfo.frameId]);
            })
            .fail(e => {
                x.def.rejectWith(this, [e]);
            })
        return def;
    }

    setVariableValue(args) {
        var frameId = Math.trunc(args.variablesReference/1e6) * 1e6;
        var stack_frame_var = this.paused.stack_frame_vars[frameId];
        return this._ensureLocals(stack_frame_var).then(varref => {
            return this.paused.stack_frame_vars[varref].locals.setVariableValue(args);
        });
    }
}

exports.AndroidThread = AndroidThread;
