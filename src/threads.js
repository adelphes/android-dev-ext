const { Debugger } = require('./debugger');
const { DebuggerException, DebuggerFrameInfo, SourceLocation } = require('./debugger-types');
const { DebuggerStackFrame } = require('./stack-frame');
const { VariableManager } = require('./variable-manager');

// vscode doesn't like thread id reuse (the Android runtime is OK with it)
let nextVSCodeThreadId = 0;

/**
 * Scales used to build VSCVariableReferences.
 * Each reference contains a thread id, frame id and variable index.
 * eg. VariableReference 1005000000 has thread:1 and frame:5
 * 
 * The variable index is the bottom 1M values.
 * - A 0 value is used for locals scope
 * - A 1 value is used for exception scope
 * - Values above 10 are used for variables
 */
const var_ref_thread_scale = 1e9;
const var_ref_frame_scale = 1e6;
const var_ref_global_frame = 999e6;

class ThreadPauseInfo {

    /**
     * @param {string} reason 
     * @param {SourceLocation} location 
     * @param {DebuggerException} last_exception 
     */
    constructor(reason, location, last_exception) {
        this.when = Date.now();   // when
        this.reasons = [reason];  // why
        this.location = location;   // where
        this.last_exception = last_exception;
        /**
         * @type {Map<VSCVariableReference,DebuggerStackFrame>}
         */
        this.stack_frames = new Map();

        /**
         * instance used to manage variables created for expressions evaluated in the global context
         * @type {VariableManager}
         */
        this.global_vars = null;

        this.stoppedEvent = null;  // event we (eventually) send to vscode
    }

    /**
     * @param {number} frameId 
     */
    getLocals(frameId) {
        return this.stack_frames.get(frameId).locals;
    }
}

/*
    Class used to manage a single thread reported by JDWP
*/
class AndroidThread {
    /**
     * 
     * @param {Debugger} dbgr 
     * @param {string} name
     * @param {JavaThreadID} threadid 
     */
    constructor(dbgr, name, threadid) {
        // the Android debugger instance
        this.dbgr = dbgr;
        // the java thread id (hex string)
        this.threadid = threadid;
        // the vscode thread id (number)
        this.vscode_threadid = (nextVSCodeThreadId += 1);
        // the (Java) name of the thread
        this.name = name;
        // the thread break info
        this.paused = null;
        // the timeout during a step which, if it expires, we allow other threads to break
        this.stepTimeout = null;
    }

    threadNotSuspendedError() {
        return new Error(`Thread ${this.vscode_threadid} not suspended`);
    }

    /**
     * @param {DebuggerFrameInfo} frame 
     * @param {number} call_stack_level 
     */
    createStackFrameVariable(frame, call_stack_level) {
        if (!this.paused) {
            throw this.threadNotSuspendedError();
        }
        const frameId = AndroidThread.makeFrameVariableReference(this.vscode_threadid, call_stack_level) ;
        const stack_frame = new DebuggerStackFrame(this.dbgr, frame, frameId);
        this.paused.stack_frames.set(frameId, stack_frame);
        return stack_frame;
    }

    /**
     * Retrieve the variable manager used to maintain variableReferences for
     * expressions evaluated in the global context for this thread.
     */
    getGlobalVariableManager() {
        if (!this.paused) {
            throw this.threadNotSuspendedError();
        }
        if (!this.paused.global_vars) {
            const globalFrameId = AndroidThread.makeGlobalVariableReference(this.vscode_threadid) ;
            this.paused.global_vars = new VariableManager(globalFrameId);
        }
        return this.paused.global_vars;
    }

    /**
     * set a new VSCode thread ID for this thread
     */
    allocateNewThreadID() {
        this.vscode_threadid = (nextVSCodeThreadId += 1);
    }

    clearStepTimeout() {
        if (this.stepTimeout) {
            clearTimeout(this.stepTimeout);
            this.stepTimeout = null;
        }
    }

    /**
     * @param {VSCVariableReference} variablesReference 
     */
    findStackFrame(variablesReference) {
        if (!this.paused) {
            return null;
        }
        const stack_frame_ref = AndroidThread.variableRefToFrameId(variablesReference);
        return this.paused.stack_frames.get(stack_frame_ref);
    }

    /**
     * @param {string} reason 
     * @param {SourceLocation} location 
     * @param {DebuggerException} last_exception 
     */
    setPaused(reason, location, last_exception) {
        this.paused = new ThreadPauseInfo(reason, location, last_exception);
        this.clearStepTimeout();
    }

    /**
     * @param {VSCThreadID} vscode_threadid 
     * @param {number} call_stack_level 
     * @returns {VSCVariableReference}
     */
    static makeFrameVariableReference(vscode_threadid, call_stack_level) {
        return (vscode_threadid * var_ref_thread_scale) + (call_stack_level * var_ref_frame_scale)
    }

    static makeGlobalVariableReference(vscode_threadid) {
        return (vscode_threadid * var_ref_thread_scale) + var_ref_global_frame;
    }

    /**
     * Convert a variable reference ID to a VSCode thread ID
     * @param {VSCVariableReference} variablesReference 
     */
    static variableRefToThreadId(variablesReference) {
        return Math.trunc(variablesReference / var_ref_thread_scale);
    }

    /**
     * Convert a variable reference ID to a frame ID
     * @param {VSCVariableReference} variablesReference 
     */
    static variableRefToFrameId(variablesReference) {
        return Math.trunc(variablesReference / var_ref_frame_scale) * var_ref_frame_scale;
    }
}


module.exports = {
    AndroidThread,
}
