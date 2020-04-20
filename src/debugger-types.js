const { ADBClient } = require('./adbclient');
const { PackageInfo } = require('./package-searcher');
//const { JavaType } = require('./util');
const { splitSourcePath } = require('./utils/source-file');

class BuildInfo {

    /**
     * @param {string} pkgname 
     * @param {Map<string,PackageInfo>} packages 
     * @param {string} launchActivity 
     * @param {string[]} amCommandArgs custom arguments passed to `am start`
     */
    constructor(pkgname, packages, launchActivity, amCommandArgs) {
        this.pkgname = pkgname;
        this.packages = packages;
        this.launchActivity = launchActivity;
        /** the arguments passed to `am start` */
        this.startCommandArgs = amCommandArgs || [
            '-D',   // enable debugging
            '--activity-brought-to-front',
            '-a android.intent.action.MAIN',
            '-c android.intent.category.LAUNCHER',
            `-n ${pkgname}/${launchActivity}`,
        ];
        /** 
         * the amount of time to wait after 'am start ...' is invoked.
         * We need this because invoking JDWP too soon causes a hang.
        */
        this.postLaunchPause = 1000;
    }
}

/**
 * A single debugger session
 */
class DebugSession {

    /**
     * @param {BuildInfo} build 
     * @param {string} deviceid 
     */
    constructor(build, deviceid) {
        /**
         * Build information for this session
         */
        this.build = build;

        /**
         * The device ID of the device being debugged
         */
        this.deviceid = deviceid;

        /**
         * The ADB connection to the device being debugged
         * @type {ADBClient}
         */
        this.adbclient = null;

        /**
         * Location of the last stop event (breakpoint, exception, step)
         * @type {SourceLocation}
         */
        this.stoppedLocation = null;

        /**
         * The entire list of retrieved types during the debug session
         * @type {DebuggerTypeInfo[]}
         */
        this.classList = [];

        /**
         * Map of type signatures to cached types
         * @type {Map<string,DebuggerTypeInfo | Promise<DebuggerTypeInfo>>}
         */
        this.classCache = new Map();

        /**
         * The class-prepare filters set up on the device
         * @type {Set<string>}
         */
        this.classPrepareFilters = new Set();

        /**
         * The set of class signatures already prepared
         * @type {Set<string>}
         */
        this.preparedClasses = new Set();

        /**
         * Enabled step JDWP IDs for each thread
         * @type {Map<JavaThreadID, StepID>}
         */
        this.stepIDs = new Map();

        /**
         * The counts of thread-suspend calls. A thread is only resumed when the
         * all suspend calls are matched with resume calls.
         * @type {Map<JavaThreadID, number>}
         */
        this.threadSuspends = new Map();

        /**
         * The queue of pending method invoke expressions to be called for each thread.
         * Method invokes can only be called sequentially on a per-thread basis.
         * @type {Map<JavaThreadID, *[]>}
         */
        this.methodInvokeQueues = new Map();
    }
}

class JavaTaggedValue {
    /**
     * 
     * @param {string|number|boolean} value 
     * @param {JavaValueType} valuetype 
     */
    constructor(value, valuetype) {
        this.value = value;
        this.valuetype = valuetype;
    }

    static signatureToJavaValueType(s) {
        return {
            B: 'byte',C:'char',D:'double',F:'float',I:'int',J:'long','S':'short',V:'void',Z:'boolean'
        }[s[0]] || 'oref';
    }

    /**
     * 
     * @param {DebuggerValue} v
     * @param {string} [signature]
     */
    static from(v, signature) {
        return new JavaTaggedValue(v.value, JavaTaggedValue.signatureToJavaValueType(signature || v.type.signature));
    }
}

/**
 * Base class of Java types
 */
class JavaType {

	/**
	 * @param {string} signature JRE type signature
	 * @param {string} typename human-readable type name
	 * @param {boolean} [invalid] true if the type could not be parsed from the signature
	 */
	constructor(signature, typename, invalid) {
		this.signature = signature;
		this.typename = typename;
		if (invalid) {
			this.invalid = invalid;
		}
    }
    
    fullyQualifiedName() {
        return this.typename;
    }

	/** @type {Map<string, JavaType>} */
	static _cache = new Map();

	/**
	 * @param {string} signature 
	 * @returns {JavaType}
	 */
	static from(signature) {
		let type = JavaType._cache.get(signature);
		if (!type) {
			type = JavaClassType.from(signature)
				|| JavaArrayType.from(signature)
				|| JavaPrimitiveType.from(signature)
				|| new JavaType(signature, signature, true);
			JavaType._cache.set(signature, type);
		}
		return type;
	}

	static get Object() {
		return JavaType.from('Ljava/lang/Object;');
	}

	static get String() {
		return JavaType.from('Ljava/lang/String;');
	}

    static get byte() {
		return JavaType.from('B');
	}
    static get short() {
		return JavaType.from('S');
	}
    static get int() {
		return JavaType.from('I');
	}
    static get long() {
		return JavaType.from('J');
	}
    static get float() {
		return JavaType.from('F');
	}
    static get double() {
		return JavaType.from('D');
	}
    static get char() {
		return JavaType.from('C');
	}
    static get boolean() {
		return JavaType.from('Z');
	}
    static null = new JavaType('Lnull;', 'null');   // null has no type really, but we need something for literals

    /**
     * @param {JavaType} t 
     */
    static isArray(t) { return /^\[/.test(t.signature) }

    /**
     * @param {JavaType} t 
     */
    static isByte(t) { return /^B$/.test(t.signature) }

    /**
     * @param {JavaType} t 
     */
    static isClass(t) { return /^L/.test(t.signature) }

    /**
     * @param {JavaType} t 
     */
    static isReference(t) { return /^[L[]/.test(t.signature) }

    /**
     * @param {JavaType} t 
     */
    static isPrimitive(t) { return /^[BCIJSFDZ]$/.test(t.signature) }

    /**
     * @param {JavaType} t 
     */
    static isInteger(t) { return /^[BIS]$/.test(t.signature) }

    /**
     * @param {JavaType} t 
     */
    static isLong(t) { return /^J$/.test(t.signature) }

    /**
     * @param {JavaType} t 
     */
    static isFloat(t) { return /^[FD]$/.test(t.signature) }

    /**
     * @param {JavaType} t 
     */
    static isArrayIndex(t) { return /^[BCIJS]$/.test(t.signature) }

    /**
     * @param {JavaType} t 
     */
    static isNumber(t) { return /^[BCIJSFD]$/.test(t.signature) }

    /**
     * @param {JavaType} t 
     */
    static isString(t) { return t.signature === this.String.signature }

    /**
     * @param {JavaType} t 
     */
    static isChar(t) { return t.signature === this.char.signature }

    /**
     * @param {JavaType} t 
     */
    static isBoolean(t) { return t.signature === this.boolean.signature }
}

class JavaClassType extends JavaType {

	/**
	 * 
	 * @param {string} signature 
	 * @param {string} package_name 
	 * @param {string} typename 
	 * @param {boolean} anonymous 
	 */
	constructor(signature, package_name, typename, anonymous) {
		super(signature, typename);
		this.package = package_name;
		this.anonymous = anonymous;
	}

    fullyQualifiedName() {
        return this.package ? `${this.package}.${this.typename}` : this.typename;
    }

    /**
	 * @param {string} signature 
	 */
	static from(signature) {
		const class_match = signature.match(/^L([^$]+)\/([^$\/]+)(\$.+)?;$/);
		if (!class_match) {
			return null;
		}
		const package_name = class_match[1].replace(/\//g,'.');
		const typename = (class_match[2]+(class_match[3]||'')).replace(/\$(?=[^\d])/g,'.');
		const anonymous = /\$\d/.test(class_match[3]);
		return new JavaClassType(signature, package_name, typename, anonymous);
	}
}

class JavaArrayType extends JavaType {

	/**
	 * @param {string} signature JRE type signature
	 * @param {number} arraydims number of array dimensions
	 * @param {JavaType} elementType array element type
	 */
	constructor(signature, arraydims, elementType) {
		super(signature, `${elementType.typename}[]`);
		this.arraydims = arraydims;
		this.elementType = elementType;
	}

    fullyQualifiedName() {
        return `${this.elementType.fullyQualifiedName()}[]`;
    }

    static from(signature) {
		const array_match = signature.match(/^(\[+)(.+)$/);
		if (!array_match) {
			return null;
		}
		const elementType = JavaType.from(array_match[1].slice(0,-1) + array_match[2]);
		return new JavaArrayType(signature, array_match[1].length, elementType);
	}
}

class JavaPrimitiveType extends JavaType {

	/**
	 * @param {string} signature 
	 * @param {string} typename 
	 */
	constructor(signature, typename) {
		super(signature, typename);
	}

	/**
	 * @param {string} signature 
	 */
	static from(signature) {
		return Object.prototype.hasOwnProperty.call(JavaPrimitiveType.bySignature, signature)
			? JavaPrimitiveType.bySignature[signature]
			: null;
	}

	static bySignature =  {
		B: new JavaPrimitiveType('B', 'byte'),
		C: new JavaPrimitiveType('C', 'char'),
		F: new JavaPrimitiveType('F', 'float'),
		D: new JavaPrimitiveType('D', 'double'),
		I: new JavaPrimitiveType('I', 'int'),
		J: new JavaPrimitiveType('J', 'long'),
		S: new JavaPrimitiveType('S', 'short'),
		V: new JavaPrimitiveType('V', 'void'),
		Z: new JavaPrimitiveType('Z', 'boolean'),
	}
}

class DebuggerValue {
    
    /**
     * @param {DebuggerValueType} vtype 
     * @param {JavaType} type 
     * @param {*} value 
     * @param {boolean} valid 
     * @param {boolean} hasnullvalue 
     * @param {string} name 
     * @param {*} data
     */
    constructor(vtype, type, value, valid, hasnullvalue, name, data) {
        this.vtype = vtype;
        this.hasnullvalue = hasnullvalue;
        this.name = name;
        this.type = type;
        this.valid = valid;
        this.value = value;
        this.data = data;

        /** @type {string} */
        this.string = null;
        /** @type {number} */
        this.biglen = null;
        /** @type {number} */
        this.arraylen = null;
        /** @type {string} */
        this.fqname = null;
    }
}

class LiteralValue extends DebuggerValue {
    /**
     * @param {JavaType} type 
     * @param {*} value 
     * @param {boolean} [hasnullvalue] 
     * @param {*} [data] 
     */
    constructor(type, value, hasnullvalue = false, data = null) {
        super('literal', type, value, true, hasnullvalue, '', data);
    }

    static Null = new LiteralValue(JavaType.null, '0000000000000000', true);
}

/**
 * The base class of all debugger events invoked by JDWP
 */
class DebuggerEvent {
    constructor(event) {
        this.event = event;
    }
}

class JavaBreakpointEvent extends DebuggerEvent {
    /**
     * 
     * @param {*} event 
     * @param {SourceLocation} stoppedLocation 
     * @param {DebuggerBreakpoint} breakpoint 
     */
    constructor(event, stoppedLocation, breakpoint) {
        super(event)
        this.stoppedLocation = stoppedLocation;
        this.bp = breakpoint;
    }
}

class JavaExceptionEvent extends DebuggerEvent {
    /**
     * @param {JavaObjectID} event 
     * @param {SourceLocation} throwlocation 
     * @param {SourceLocation} catchlocation 
     */
    constructor(event, throwlocation, catchlocation) {
        super(event);
        this.throwlocation = throwlocation;
        this.catchlocation = catchlocation;
    };
}

class DebuggerException {
    /**
     * @param {DebuggerValue} exceptionValue 
     * @param {JavaThreadID} threadid 
     */
    constructor(exceptionValue, threadid) {
        this.exceptionValue = exceptionValue;
        this.threadid = threadid;
        /** @type {VSCVariableReference} */
        this.scopeRef = null;
        /** @type {VSCVariableReference} */
        this.frameId = null;
    }
}

class BreakpointLocation {
    /**
     * @param {DebuggerBreakpoint} bp 
     * @param {DebuggerTypeInfo} c 
     * @param {DebuggerMethodInfo} m 
     * @param {hex64} l 
     */
    constructor(bp, c, m, l) {
        this.bp = bp;
        this.c = c;
        this.m = m;
        this.l = l;
    }
}

class SourceLocation {

    /**
     * @param {string} qtype 
     * @param {number} linenum 
     * @param {boolean} exact 
     * @param {JavaThreadID} threadid 
     */
    constructor(qtype, linenum, exact, threadid) {
        this.qtype = qtype;
        this.linenum = linenum;
        this.exact = exact;
        this.threadid = threadid;
    }

    toString() {
        return JSON.stringify(this);
    }
}

class DebuggerMethodInfo {

    /**
     * @param {JavaMethod} m 
     * @param {DebuggerTypeInfo} owningclass
     */
    constructor(m, owningclass) {
        this._method = m;
        this.owningclass = owningclass;
        /** @type {JavaVarTable} */
        this.vartable = null;
        /** @type {JavaLineTable} */
        this.linetable = null;
    }

    get genericsig() { return this._method.genericsig }

    get methodid() { return this._method.methodid }

    /**
     * https://docs.oracle.com/javase/specs/jvms/se7/html/jvms-4.html#jvms-4.6-200-A.1
     */
    get modbits() { return this._method.modbits }

    get name() { return this._method.name }

    get sig() { return this._method.sig }

    get isStatic() {
        return (this._method.modbits & 0x0008) !== 0;
    }

    /**
     * @param {JavaLineTable} linetable 
     */
    setLineTable(linetable) {
        return this.linetable = linetable;
    }

    /**
     * @param {JavaVarTable} vartable 
     */
    setVarTable(vartable) {
        return this.vartable = vartable;
    }

    get returnTypeSignature() {
        return (this._method.genericsig || this._method.sig).match(/\)(.+)$/)[1];
    }

    static NullLineTable = {
        start: '0000000000000000',
        end: '0000000000000000',
        lines: [],
    };
}

class DebuggerFrameInfo {
    /**
     * 
     * @param {JavaFrame} frame 
     * @param {DebuggerMethodInfo} method 
     * @param {JavaThreadID} threadid 
     */
    constructor(frame, method, threadid) {
        this._frame = frame;
        this.method = method;
        this.threadid = threadid;
    }

    get frameid() {
        return this._frame.frameid;
    }

    get location() {
        return this._frame.location;
    }
}

class DebuggerBreakpoint {

    /**
     * @param {string} srcfpn 
     * @param {number} linenum 
     * @param {BreakpointOptions} options 
     * @param {BreakpointState} initialState 
     */
    constructor(srcfpn, linenum, options, initialState = 'set') {
        const cls = splitSourcePath(srcfpn);
        this.id = DebuggerBreakpoint.makeBreakpointID(srcfpn, linenum);
        this.srcfpn = srcfpn;
        this.qtype = cls.qtype;
        this.pkg = cls.pkg;
        this.type = cls.type;
        this.linenum = linenum;
        this.options = options;
        this.sigpattern = new RegExp(`^L${cls.qtype}([$][$a-zA-Z0-9_]+)?;$`),
        this.state = initialState;     // set,notloaded,enabled,removed
        this.hitcount = 0;      // number of times this bp was hit during execution
        this.stopcount = 0;     // number of times this bp caused a break into the debugger
        this.vsbp = null;
        this.enabled = null;
    }

    /**
     * @param {BreakpointLocation} bploc 
     * @param {number} requestid JDWP request ID for the breakpoint
     */
    setEnabled(bploc, requestid) {
        this.enabled = {
            /** @type {CMLKey} */
            cml: `${bploc.c.info.typeid}:${bploc.m.methodid}:${bploc.l}`,
            bp: this,
            bploc: {
                c: bploc.c,
                m: bploc.m,
                l: bploc.l,
            },
            requestid,
        }
    }

    setDisabled() {
        this.enabled = null;
    }

    /**
     * Constructs a unique breakpoint ID from the source path and line number
     * @param {string} srcfpn 
     * @param {number} line 
     * @returns {BreakpointID}
     */
    static makeBreakpointID(srcfpn, line) {
        const cls = splitSourcePath(srcfpn);
        return `${line}:${cls.qtype}`;
    }
}

class BreakpointOptions {
    /**
     * Hit-count used for conditional breakpoints
     * @type {number|null}
     */
    hitcount = null;
}

class DebuggerTypeInfo {

    /**
     * @param {JavaClassInfo} info
     * @param {JavaType} type 
     */
    constructor(info, type) {
        this.info = info;
        this.type = type;

        /** @type {JavaField[]} */
        this.fields = null;

        /** @type {DebuggerMethodInfo[]} */
        this.methods = null;

        /** @type {JavaSource} */
        this.src = null;

        // if it's not a class type, set super to null
        // otherwise, leave super undefined to be updated later
        if (info.reftype.string !== 'class' || type.signature[0] !== 'L' || type.signature === JavaType.Object.signature) {
            if (info.reftype.string !== 'array') {
                /** @type {JavaType} */
                this.super = null;
            }
        }
    }

    get name() {
        return this.type.typename;
    }
}

/**
 * Dummy type info for when the Java runtime hasn't loaded the class.
 */
class TypeNotAvailable extends DebuggerTypeInfo  {
    /** @type {JavaClassInfo} */
    static info = {
        reftype: 0,
        status: null,
        type: null,
        typeid: '',
    }

    constructor(type) {
        super(TypeNotAvailable.info, type);
        super.fields = [];
        super.methods = [];
    }
}

class JavaThreadInfo {
    /**
     * @param {JavaThreadID} threadid 
     * @param {string} name 
     * @param {*} status 
     */
    constructor(threadid, name, status) {
        this.threadid = threadid;
        this.name = name;
        this.status = status;
    }
}

class MethodInvokeArgs {
    /**
     * @param {JavaObjectID} objectid 
     * @param {JavaThreadID} threadid 
     * @param {DebuggerMethodInfo} method 
     * @param {DebuggerValue[]} args 
     */
    constructor(objectid, threadid, method, args) {
        this.objectid = objectid;
        this.threadid = threadid;
        this.method = method;
        this.args = args;
        this.promise = null;
    }
}
    
class VariableValue {
    /**
     * @param {string} name 
     * @param {string} value 
     * @param {string} [type]
     * @param {number} [variablesReference]
     * @param {string} [evaluateName]
     */
    constructor(name, value, type = '', variablesReference = 0, evaluateName = '') {
        this.name = name;
        this.value = value;
        this.type = type;
        this.variablesReference = variablesReference;
        this.evaluateName = evaluateName;
    }
}

module.exports = {
    BreakpointLocation,
    BreakpointOptions,
    BuildInfo,
    DebuggerBreakpoint,
    DebuggerException,
    DebuggerFrameInfo,
    DebuggerMethodInfo,
    DebuggerTypeInfo,
    DebugSession,
    DebuggerValue,
    LiteralValue,
    JavaBreakpointEvent,
    JavaExceptionEvent,
    JavaTaggedValue,
	JavaType,
	JavaArrayType,
	JavaClassType,
    JavaPrimitiveType,
    JavaThreadInfo,
    MethodInvokeArgs,
    SourceLocation,
    TypeNotAvailable,
    VariableValue,
}
