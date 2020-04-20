const { Debugger } = require('../debugger');
const { DebuggerValue, JavaTaggedValue, JavaType } = require('../debugger-types');
const { NumberBaseConverter } = require('../utils/nbc');

const validmap = {
    B: 'BC',   // char might not fit into a byte - we special-case this
    S: 'BSC',
    I: 'BSIC',
    J: 'BSIJC',
    F: 'BSIJCF',
    D: 'BSIJCFD',
    C: 'BSC',
    Z: 'Z',
    isCharInRangeForByte: c => c.charCodeAt(0) < 256,
};

/**
 * Checks if the value will fit into a variable with given type
 * @param {JavaType} variable_type 
 * @param {DebuggerValue} value 
 */
function checkPrimitiveSize(variable_type, value) {
    // variable_type_signature must be a primitive
    if (!Object.prototype.hasOwnProperty.call(validmap, variable_type.signature)) {
        return false;
    }

    let value_type_signature = value.type.signature;
    if (value.vtype === 'literal' && /[BSI]/.test(value_type_signature)) {
        // for integer literals, find the minimum type the value will fit into
        if (value.value >= -128 && value.value <= 127) value_type_signature = 'B';
        else if (value.value >= -32768 && value.value <= 32767) value_type_signature = 'S';
        else if (value.value >= -2147483648 && value.value <= 2147483647) value_type_signature = 'I';
    }

    let is_in_range = validmap[variable_type.signature].indexOf(value_type_signature) >= 0;
    
    // special check to see if a char value fits into a single byte
    if (JavaType.isByte(variable_type) && JavaType.isChar(value.type)) {
        is_in_range = validmap.isCharInRangeForByte(value.value);
    }

    return is_in_range;
}

/**
 * @param {Debugger} dbgr 
 * @param {DebuggerValue} destvar 
 * @param {string} name 
 * @param {DebuggerValue} result 
 */
async function assignVariable(dbgr, destvar, name, result) {
    if (!destvar || !/^(field|local|arrelem)$/.test(destvar.vtype)) {
        throw new Error(`The value is read-only and cannot be updated.`);
    }

    // non-string reference types can only set to null
    if (JavaType.isReference(destvar.type) && !JavaType.isString(destvar.type)) {
        if (!result.hasnullvalue) {
            throw new Error('Object references can only be set to null');
        }
    }

    // as a nicety, if the destination is a string, stringify any primitive value
    if (JavaType.isPrimitive(result.type) && JavaType.isString(destvar.type)) {
        result = await dbgr.createJavaStringLiteral(result.value.toString(), { israw:true });
    }
    
    if (JavaType.isPrimitive(destvar.type)) {
        // if the destination is a primitive, we need to range-check it here
        // Neither our debugger nor the JDWP endpoint validates primitives, so we end up with
        // weirdness if we allow primitives to be set with out-of-range values
        const is_in_range = checkPrimitiveSize(destvar.type, result);
        if (!is_in_range) {
            throw new Error(`'${result.value}' is not compatible with variable type: ${destvar.type.typename}`);
        }
    }

    const data = JavaTaggedValue.from(result, destvar.type.signature);

    if (JavaType.isLong(destvar.type) && typeof data.value === 'number') {
        // convert ints to hex-string longs
        data.value = NumberBaseConverter.decToHex(data.value.toString(),16);
    }

    // convert the debugger value to a JavaTaggedValue
    let newlocalvar;
    // setxxxvalue sets the new value and then returns a new local for the variable
    switch(destvar.vtype) {
        case 'field':
            newlocalvar = await dbgr.setFieldValue(destvar.data.objvar, destvar.data.field, data);
            break;
        case 'local':
            newlocalvar = await dbgr.setLocalVariableValue(destvar.data.frame, destvar.data.slotinfo, data);
            break;
        case 'arrelem': 
            newlocalvar = await dbgr.setArrayElements(destvar.data.array, parseInt(name, 10), 1, data);
            newlocalvar = newlocalvar[0];
            break;
        default:
            throw new Error('Unsupported variable type');
    }

    return newlocalvar;
}

module.exports = {
    assignVariable,
}
