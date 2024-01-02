const { JavaType, VariableValue } = require('./debugger-types');
const { NumberBaseConverter } = require('./utils/nbc');

/**
 * @typedef {import('./debugger-types').DebuggerValue} DebuggerValue
 */

/**
 * Class to manage variable references used by VS code.
 * 
 * This class is primarily used to manage references to variables created in stack frames, but is 
 * also used in 'standalone' mode for repl expressions evaluated in the global context.
 */
class VariableManager {
    /**
     * @param {VSCVariableReference} base_variable_reference The reference value for values stored by this manager
     */
    constructor(base_variable_reference) {

        /** @type {VSCVariableReference} */
        this.nextVariableRef = base_variable_reference + 10;

        /** @type {Map<VSCVariableReference,*>} */
        this.variableValues = new Map();

        /** @type {Map<JavaObjectID,VSCVariableReference>} */
        this.objIdCache = new Map();
    }

    _addVariable(varinfo) {
        varinfo.varref = this.nextVariableRef += 1;
        this._setVariable(varinfo.varref, varinfo)
        return varinfo.varref;
    }

    /**
     * 
     * @param {VSCVariableReference} variablesReference 
     * @param {*} value 
     */
    _setVariable(variablesReference, value) {
        this.variableValues.set(variablesReference, value);
    }

    /**
     * Retrieve or create a variable reference for a given object instance
     * @param {JavaType} type 
     * @param {JavaObjectID} instance_id 
     * @param {string} display_format 
     */
    _getObjectIdReference(type, instance_id, display_format) {
        // we need the type signature because we must have different id's for
        // an instance and it's supertype instance (which obviously have the same instance_id)
        //
        // display_format is also included to give unique variable references for each display type.
        // This is because VSCode caches expanded values, so once evaluated in one format, they can
        // never be changed.
        const key = `${type.signature}:${instance_id}:${display_format || ''}`;
        let value = this.objIdCache.get(key);
        if (!value) {
            this.objIdCache.set(key, value = this.nextVariableRef += 1);
        }
        return value;
    }

    /**
     * Convert to a VariableValue object used by VSCode
     * @param {DebuggerValue} v
     * @param {string} [display_format]
     */
    makeVariableValue(v, display_format) {
        let varref = 0;
        let value = '';
        const evaluateName = v.fqname || v.name;
        const full_typename = v.type.fullyQualifiedName();
        switch(true) {
            case v.hasnullvalue && JavaType.isReference(v.type):
                // null object or array type
                value = 'null';
                break;
            case v.vtype === 'class':
                value = full_typename;
                break;
            case v.type.signature === JavaType.Object.signature:
                // Object doesn't really have anything worth seeing, so just treat it as unexpandable
                value = v.type.typename;
                break;
            case v.type.signature === JavaType.String.signature:
                if (v.biglen) {
                    // since this is a big string - make it viewable on expand
                    varref = this._addVariable({
                        bigstring: v,
                    });
                    value = `String (length:${v.biglen})`;
                } else {
                    value = formatString(v.string, display_format);
                }
                break;
            case JavaType.isArray(v.type):
                // non-null array type - if it's not zero-length add another variable reference so the user can expand
                if (v.arraylen) {
                    varref = this._getObjectIdReference(v.type, v.value, display_format);
                    this._setVariable(varref, {
                        varref,
                        arrvar: v,
                        range:[0, v.arraylen],
                        display_format,
                    });
                }
                value = v.type.typename.replace(/]/, v.arraylen+']');   // insert len as the first array bound
                break;
            case JavaType.isClass(v.type):
                // non-null object instance - add another variable reference so the user can expand
                varref = this._getObjectIdReference(v.type, v.value, display_format);
                this._setVariable(varref, {
                    varref,
                    objvar: v,
                    display_format,
                });
                value = v.type.typename;
                break;
            case v.type.signature === JavaType.char.signature: 
                // character types have a integer value
                value = formatChar(v.value, display_format);
                break;
            case v.type.signature === JavaType.long.signature:
                // because JS cannot handle 64bit ints, we need a bit of extra work
                const v64hex = v.value.replace(/[^0-9a-fA-F]/g,'');
                value = formatLong(v64hex, display_format);
                break;
            case JavaType.isInteger(v.type):
                value = formatInteger(v.value, v.type.signature, display_format);
                break;
            default:
                // other primitives: boolean, etc
                value = v.value.toString();
                break;
        }

        return new VariableValue(v.name, value, full_typename, varref, evaluateName);
    }
}

const cmap = {
    '\b':'b','\f':'f','\r':'r','\n':'n','\t':'t',
    '\v':'v','\'':'\'','\\':'\\','\0':'0'
};

function makeJavaChar(i) {
    let value;
    const char = String.fromCodePoint(i);
    if (cmap[char]) {
        value = `'\\${cmap[char]}'`;
    } else if (i < 32) {
        value = `'\\u${i.toString(16).padStart(4,'0')}'`;
    } else value = `'${char}'`;
    return value;
}

/**
 * @param {number} c 
 * @param {string} df 
 */
function formatChar(c, df) {
    if (/[xX]b|o|bb|d/.test(df)) {
        return formatInteger(c, 'C', df);
    }
    return makeJavaChar(c);

}

/**
 * 
 * @param {string} s
 * @param {string} display_format 
 */
function formatString(s, display_format) {
    if (display_format === '!') {
        return s;
    }
    let value = JSON.stringify(s);
    if (display_format === 'sb') {
        // remove quotes
        value = value.slice(1,-1);
    }
    return value;
}

/**
 * @param {hex64} hex64 
 * @param {string} df 
 */
function formatLong(hex64, df) {
    let minlength;
    if (/[xX]b?/.test(df)) {
        minlength = Math.ceil(64 / 4);
        let s = `${df[1]?'':'0x'}${hex64.padStart(minlength,'0')}`;
        return df[0] === 'x' ? s.toLowerCase() : s.toUpperCase();
    }
    if (/o/.test(df)) {
        minlength = Math.ceil(64 / 3);
        return `${df[1]?'':'0'}${NumberBaseConverter.convertBase(hex64,16,8).padStart(minlength, '0')}`;
    }
    if (/bb?/.test(df)) {
        minlength = 64;
        return `${df[1]?'':'0b'}${NumberBaseConverter.convertBase(hex64,16,2).padStart(minlength, '0')}`;
    }
    if (/c/.test(df)) {
        return makeJavaChar(parseInt(hex64.slice(-4), 16));
    }
    return NumberBaseConverter.convertBase(hex64, 16, 10);
}

/**
 * @param {number} i 
 * @param {string} signature 
 * @param {string} df 
 */
function formatInteger(i, signature, df) {
    const bits = { B:8,S:16,I:32,C:16 }[signature];
    let u = (i & (-1 >>> (32 - bits))) >>> 0;
    let minlength;
    if (/[xX]b?/.test(df)) {
        minlength = Math.ceil(bits / 4);
        let s = u.toString(16).padStart(minlength,'0');
        s = df[0] === 'x' ? s.toLowerCase() : s.toUpperCase();
        return `${df[1]?'':'0x'}${s}`;
    }
    if (/o/.test(df)) {
        minlength = Math.ceil(bits / 3);
        return `${df[1]?'':'0'}${u.toString(8).padStart(minlength, '0')}`;
    }
    if (/bb?/.test(df)) {
        minlength = bits;
        return `${df[1]?'':'0b'}${u.toString(2).padStart(minlength, '0')}`;
    }
    if (/c/.test(df)) {
        minlength = bits;
        return makeJavaChar(u & 0xffff);
    }
    return i.toString();
}

module.exports = {
    VariableManager,
}
