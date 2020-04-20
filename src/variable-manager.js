const { DebuggerValue, JavaType, VariableValue } = require('./debugger-types');
const { NumberBaseConverter } = require('./utils/nbc');

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
        // expandable variables get allocated new variable references.
        this._expandable_prims = false;

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

    _getObjectIdReference(type, objvalue) {
        // we need the type signature because we must have different id's for
        // an instance and it's supertype instance (which obviously have the same objvalue)
        const key = type.signature + objvalue;
        let value = this.objIdCache.get(key);
        if (!value) {
            this.objIdCache.set(key, value = this.nextVariableRef += 1);
        }
        return value;
    }

    /**
     * Convert to a VariableValue object used by VSCode
     * @param {DebuggerValue} v
     */
    makeVariableValue(v) {
        let varref = 0;
        let value = '';
        const evaluateName = v.fqname || v.name;
        const formats = {};
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
                value = JSON.stringify(v.string);
                if (v.biglen) {
                    // since this is a big string - make it viewable on expand
                    varref = this._addVariable({
                        bigstring: v,
                    });
                    value = `String (length:${v.biglen})`;
                }
                else if (this._expandable_prims) {
                    // as a courtesy, allow strings to be expanded to see their length
                    varref = this._addVariable({
                        signature: v.type.signature,
                        primitive: true,
                        value: v.string.length
                    });
                }
                break;
            case JavaType.isArray(v.type):
                // non-null array type - if it's not zero-length add another variable reference so the user can expand
                if (v.arraylen) {
                    varref = this._getObjectIdReference(v.type, v.value);
                    this._setVariable(varref, {
                        varref,
                        arrvar: v,
                        range:[0, v.arraylen],
                    });
                }
                value = v.type.typename.replace(/]/, v.arraylen+']');   // insert len as the first array bound
                break;
            case JavaType.isClass(v.type):
                // non-null object instance - add another variable reference so the user can expand
                varref = this._getObjectIdReference(v.type, v.value);
                this._setVariable(varref, {
                    varref,
                    objvar: v,
                });
                value = v.type.typename;
                break;
            case v.type.signature === JavaType.char.signature: 
                // character types have a integer value
                const char = String.fromCodePoint(v.value);
                const cmap = {'\b':'b','\f':'f','\r':'r','\n':'n','\t':'t','\v':'v','\'':'\'','\\':'\\','\0':'0'};
                if (cmap[char]) {
                    value = `'\\${cmap[char]}'`;
                } else if (v.value < 32) {
                    value = `'\\u${v.value.toString(16).padStart(4,'0')}'`;
                } else value = `'${char}'`;
                break;
            case v.type.signature === JavaType.long.signature:
                // because JS cannot handle 64bit ints, we need a bit of extra work
                const v64hex = v.value.replace(/[^0-9a-fA-F]/g,'');
                value = formats.dec = NumberBaseConverter.hexToDec(v64hex, true);
                formats.hex = '0x' + v64hex.replace(/^0+/, '0');
                formats.oct = formats.bin = '';
                // 24 bit chunks...
                for (let s = v64hex; s; s = s.slice(0,-6)) {
                    const uint = parseInt(s.slice(-6), 16) >>> 0; // 6*4 = 24 bits
                    formats.oct = uint.toString(8) + formats.oct;
                    formats.bin = uint.toString(2) + formats.bin;
                }
                formats.oct = '0c' + formats.oct.replace(/^0+/, '0');
                formats.bin = '0b' + formats.bin.replace(/^0+/, '0');
                break;
            case JavaType.isInteger(v.type):
                value = formats.dec = v.value.toString();
                const uint = (v.value >>> 0);
                formats.hex = '0x' + uint.toString(16);
                formats.oct = '0c' + uint.toString(8);
                formats.bin = '0b' + uint.toString(2);
                break;
            default:
                // other primitives: boolean, etc
                value = v.value.toString();
                break;
        }
        // as a courtesy, allow integer and character values to be expanded to show the value in alternate bases
        if (this._expandable_prims && /^[IJBSC]$/.test(v.type.signature)) {
            varref = this._addVariable({
                signature: v.type.signature,
                primitive: true,
                value: v.value,
            });
        }
        return new VariableValue(v.name, value, full_typename, varref, evaluateName);
    }
}

module.exports = {
    VariableManager,
}
