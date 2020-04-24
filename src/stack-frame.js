const { Debugger } = require('./debugger');
const { DebuggerFrameInfo, DebuggerValue, JavaType, LiteralValue, VariableValue } = require('./debugger-types');
const { assignVariable } = require('./expression/assign');
const { NumberBaseConverter } = require('./utils/nbc');
const { VariableManager } = require('./variable-manager');

/**
 * @param {DebuggerValue[]} variables 
 * @param {boolean} thisFirst 
 * @param {boolean} allCapsLast 
 */
function sortVariables(variables, thisFirst, allCapsLast) {
    return variables.sort((a,b) => {
        if (a.name === b.name) return 0;
        if (thisFirst) {
            if (a.name === 'this') return -1;
            if (b.name === 'this') return +1;
        }
        if (allCapsLast) {
            const acaps = !/[a-z]/.test(a.name);
            const bcaps = !/[a-z]/.test(b.name);
            if (acaps !== bcaps) {
                return acaps ? +1 : -1;
            }
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

class DebuggerStackFrame extends VariableManager {

    /**
     * @param {Debugger} dbgr
     * @param {DebuggerFrameInfo} frame 
     * @param {VSCVariableReference} frame_variable_reference 
     */
    constructor(dbgr, frame, frame_variable_reference) {
        super(frame_variable_reference );
        this.variableReference = frame_variable_reference;
        this.dbgr = dbgr;
        this.frame = frame;
        /** @type {DebuggerValue[]} */
        this.locals = null;
    }

    /**
     * Return the list of local values for this stack frame
     * @returns {Promise<DebuggerValue[]>}
     */
    async getLocals() {
        if (this.locals) {
            return this.locals;
        }
        const fetch_locals = async () => {
            const values = await this.dbgr.getLocals(this.frame);
            // display the variables in (case-insensitive) alphabetical order, with 'this' first
            return this.locals = sortVariables(values, true, false);
        }
        // @ts-ignore
        return this.locals = fetch_locals();
    }

    async getLocalVariables() {
        const values = await this.getLocals();
        return values.map(value => this.makeVariableValue(value));
    }

    /**
     * @param {VSCVariableReference} variablesReference 
     * @param {string} name
     * @param {DebuggerValue} value 
     */
    async setVariableValue(variablesReference, name, value) {

        /** @type {DebuggerValue[]} */
        let variables;
        if (variablesReference === this.variableReference) {
            variables = this.locals;
        } else {
            const varinfo = this.variableValues.get(variablesReference);
            if (!varinfo || !varinfo.cached) {
                throw new Error(`Variable '${name}' not found`);
            }
            variables = varinfo.cached;
        }

        const var_idx = variables.findIndex(v => v.name === name);

        try {
            const updated_value = await assignVariable(this.dbgr, variables[var_idx], name, value);
            variables[var_idx] = updated_value;
            return this.makeVariableValue(updated_value);
        } catch(e) {
            throw new Error(`Variable update failed. ${e.message}`);
        }
    }

    /**
     * @param {VSCVariableReference} variablesReference 
     * @returns {Promise<VariableValue[]>}
     */
    async getExpandableValues(variablesReference) {
        const varinfo = this.variableValues.get(variablesReference);
        if (!varinfo) {
            return [];
        }
        if (varinfo.cached) {
            // return the cached version
            return varinfo.cached.map(v => this.makeVariableValue(v));
        }
        if (varinfo.primitive) {
            // convert the primitive value into alternate formats
            return this.getPrimitive(varinfo);
        }

        /** @type {DebuggerValue[]} */
        let values = [];
        if (varinfo.objvar) {
            // object fields request
            values = sortVariables(await this.getObjectFields(varinfo), false, true);
        }
        else if (varinfo.arrvar) {
            // array elements request
            const arr = await this.getArrayElements(varinfo);
            if (arr.isSubrange) {
                // @ts-ignore
                return arr.values;
            }
            // @ts-ignore
            values = arr.values;
        }
        else if (varinfo.bigstring) {
            values = [await this.getBigString(varinfo)];
        }

        return (varinfo.cached = values).map(v => this.makeVariableValue(v, varinfo.display_format));
    }

    async getObjectFields(varinfo) {
        const supertype = await this.dbgr.getSuperType(varinfo.objvar);
        const fields = await this.dbgr.getFieldValues(varinfo.objvar);
        // add an extra msg field for exceptions
        if (varinfo.exception) {
            const call = await this.dbgr.invokeToString(varinfo.objvar.value, varinfo.threadid, varinfo.objvar.type.signature);
            call.name = ":message";
            fields.unshift(call);
        }
        // add a ":super" member, unless the super is Object
        if (supertype && supertype.signature !== JavaType.Object.signature) {
            fields.unshift(new DebuggerValue('super', supertype, varinfo.objvar.value, true, false, ':super', null));
        }
        return fields;
    }

    async getArrayElements(varinfo) {
        const range = varinfo.range,
            count = range[1] - range[0];
        // should always have a +ve count, but just in case...
        if (count <= 0) {
            return null;
        }
        // counts over 110 are shown as subranges
        if (count > 110) {
            return {
                isSubrange: true,
                values: this.getArraySubrange(varinfo.arrvar, count, range),
            };
        }
        // get the elements for the specified range
        const elements = await this.dbgr.getArrayElementValues(varinfo.arrvar, range[0], count);
        return {
            isSubrange: false,
            values: elements,
        }
    }

    /**
     * 
     * @param {*} arrvar 
     * @param {number} count 
     * @param {[number,number]} range 
     */
    getArraySubrange(arrvar, count, range) {
        // create subranges in the sub-power of 10
        const subrangelen = Math.max(Math.pow(10, (Math.log10(count)|0)-1),100);
        /** @type {VariableValue[]} */
        const variables = [];

        for (let i = range[0]; i < range[1]; i+= subrangelen) {
            const varinfo = {
                varref: 0,
                arrvar,
                range: [i, Math.min(i+subrangelen, range[1])],
            };
            const varref = this._addVariable(varinfo);
            const variable = new VariableValue(`[${varinfo.range[0]}..${varinfo.range[1]-1}]`, '', null, varref, '');
            variables.push(variable);
        }

        return variables;
    }

    async getBigString(varinfo) {
        const string = await this.dbgr.getStringText(varinfo.bigstring.value);
        const res = new LiteralValue(JavaType.String, string);
        res.name = '<value>';
        res.string = string;
        return res;
    }

    getPrimitive(varinfo) {
        /** @type {VariableValue[]} */
        const variables = [];
        const bits = {
            J:64,
            I:32,
            S:16,
            B:8,
        }[varinfo.signature];

        /**
         * 
         * @param {number|hex64} n 
         * @param {number} base 
         * @param {number} len 
         */
        function convert(n, base, len) {
            let converted;
            if (typeof n === 'string') {
                converted = {
                    2: () => n.replace(/./g, c => parseInt(c,16).toString(2)),
                    10: () => NumberBaseConverter.hexToDec(n, false),
                    16: () => n,
                }[base]();
            } else {
                converted = n.toString(base);
            }
            return converted.padStart(len, '0');
        }

        /**
         * @param {number|hex64} u 
         * @param {8|16|32|64} bits 
         */
        function getIntFormats(u, bits) {
            const bases = [2, 10, 16];
            const min_lengths = [bits, 1, bits/4];
            const base_names = ['<binary>', '<decimal>', '<hex>'];
            return base_names.map((name, i) => new VariableValue(name, convert(u, bases[i], min_lengths[i])));
        }

        switch(varinfo.signature) {
            case 'Ljava/lang/String;':
                variables.push(new VariableValue('<length>', varinfo.value.toString()));
                break;
            case 'C': 
                variables.push(new VariableValue('<charCode>', varinfo.value.charCodeAt(0).toString()));
                break;
            case 'J':
                // because JS cannot handle 64bit ints, we need a bit of extra work
                const v64hex = varinfo.value.replace(/[^0-9a-fA-F]/g,'');
                variables.push(...getIntFormats(v64hex, 64));
                break;
            default:// integer/short/byte value
                const u = varinfo.value >>> 0;
                variables.push(...getIntFormats(u, bits));
                break;
        }
        return variables;
    }

}

module.exports = {
    DebuggerStackFrame,
}
