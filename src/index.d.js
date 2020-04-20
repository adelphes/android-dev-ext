/**
 * @typedef {string} hex64
 * @typedef {hex64} JavaRefID
 * @typedef {number} VSCThreadID
 * @typedef {number} VSCVariableReference
 * A variable reference is a number, encoding the thread, stack level and variable index, using:
 * 
 *     variableReference = {threadid * 1e9} + {level * 1e6} + varindex
 * 
 * This allows 1M variables (locals, fields, array elements) per call stack frame
 * and 1000 frames per call stack

 * @typedef {number} byte
 * 
 * @typedef {JavaRefID} JavaFrameID
 * @typedef {JavaRefID} JavaThreadID
 * @typedef {JavaRefID} JavaClassID
 * @typedef {JavaRefID} JavaMethodID
 * @typedef {JavaRefID} JavaFieldID
 * @typedef {JavaRefID} JavaObjectID
 * @typedef {JavaRefID} JavaTypeID
 *
 * @typedef JavaFrame
 * @property {JavaFrameID} frameid
 * @property {JavaLocation} location
 * 
 * @typedef JavaClassInfo
 * @property {*} reftype
 * @property {*} status
 * @property {JavaType} type
 * @property {JavaTypeID} typeid
 * 
 * @typedef JavaMethod
 * @property {string} genericsig
 * @property {JavaMethodID} methodid
 * @property {byte} modbits
 * @property {string} name
 * @property {string} sig
 * 
 * @typedef JavaSource
 * @property {string} sourcefile
 * 
 * @typedef JavaLocation
 * @property {JavaClassID} cid
 * @property {hex64} idx
 * @property {JavaMethodID} mid
 * @property {1} type
 * 
 * @typedef JavaLineTable
 * @property {hex64} start
 * @property {hex64} end
 * @property {JavaLineTableEntry[]} lines
 * 
 * @typedef JavaLineTableEntry
 * @property {hex64} linecodeidx
 * @property {number} linenum
 * 
 *
 * @typedef JavaField
 * @property {JavaFieldID} fieldid
 * @property {string} name
 * @property {JavaType} type
 * @property {string} genericsig
 * @property {number} modbits
 *
 * @typedef JavaVar
 * @property {*} codeidx
 * @property {string} name
 * @property {JavaType} type
 * @property {string} genericsig
 * @property {number} length
 * @property {number} slot
 * 
 * @typedef JavaVarTable
 * @property {number} argCnt
 * @property {JavaVar[]} vars
 * 
 * @typedef {'byte'|'short'|'int'|'long'|'boolean'|'char'|'float'|'double'|'void'|'oref'} JavaValueType
 * 
 * @typedef HitMod
 * @property {1} modkind
 * @property {number} count
 * @property {() => void} encode
 * 
 * @typedef ClassMatchMod
 * @property {5} modkind
 * @property {string} pattern
 * 
 * @typedef LocMod
 * @property {7} modkind
 * @property {*} loc
 * @property {() => void} encode
 * 
 * @typedef ExOnlyMod
 * @property {8} modkind
 * @property {*} reftypeid
 * @property {boolean} caught
 * @property {boolean} uncaught
 **/


/**
 * @typedef {"local" | "literal" | "field" | "exception" | "return" | "arrelem" | "super" | "class" | "package"} DebuggerValueType
 * @typedef {'in'|'over'|'out'} DebuggerStepType
 * @typedef {'set'|'notloaded'|'enabled'|'removed'} BreakpointState
 * @typedef {string} BreakpointID
 * @typedef {string} CMLKey
 * @typedef {number} JDWPRequestID
 * @typedef {JDWPRequestID} StepID
 * @typedef {'caught'|'uncaught'|'both'} ExceptionBreakMode
 * 
 */

/**
 * @typedef ADBFileTransferParams
 * @property {string} pathname
 * @property {Buffer} data
 * @property {number} mtime
 * @property {number} perms
 *
 */
