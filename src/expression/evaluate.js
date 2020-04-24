const Long = require('long');

const {
    ArrayIndexExpression,
    BinaryOpExpression,
    ExpressionText,
    MemberExpression,
    MethodCallExpression,
    parse_expression,
    ParsedExpression,
    QualifierExpression,
    RootExpression,
    TypeCastExpression,
    UnaryOpExpression,
} = require('./parse');
const { DebuggerValue, JavaTaggedValue, JavaType, LiteralValue } = require('../debugger-types');
const { Debugger } = require('../debugger');
const { AndroidThread } = require('../threads');
const { D } = require('../utils/print');
const { decodeJavaCharLiteral } = require('../utils/char-decode');

/**
 * @param {Long.Long} long 
 */
function hex_long(long) {
    return long.toUnsigned().toString(16).padStart(64/4, '0');
}

/**
 * Determine what type of primitive a decimal value will require
 * @param {string} decimal_value 
 * @returns {'int'|'long'|'float'|'double'}
 */
function get_decimal_number_type(decimal_value) {
    if (/^-?0*\d{0,15}(\.0*)?$/.test(decimal_value)) {
        const n = parseInt(decimal_value, 10);
        if (n >= -2147483648 && n <= 2147483647) {
            return 'int';
        }
        return 'long';
    }
    // int64: 9223,372036854775807
    let m = decimal_value.match(/^(-?)0*(\d*?)(\d{1,4})(\d{15})(\.0+)?$/);
    if (m) {
        const sign = m[1];
        if (!m[2]) {
            const x = [parseInt(m[3],10), parseInt(m[4],10)];
            if (x[0] < 9223) {
                return 'long';
            }
            if (x[0] > 9223) {
                return 'float';
            }
            let limit = 372036854775807 + (sign ? 1 : 0);
            if (x[1] <= limit) {
                return 'long';
            }
            return 'float'
        }
        // single precision floats allow integers up to +/- 2^127:
        //   34028,236692093846346,3374,607431768211455
        // but rounded to a power of 2 (not checked here)
        let q = m[2].match(/^(\d*?)(\d{0,5}?)(\d{1,15})$/);
        if (q[1]) {
            return 'double';
        }
        const x = [parseInt(q[2],10), parseInt(q[3],10), parseInt(m[3],10), parseInt(m[4],10)]
        if (x[0] > 34028) {
            return 'double';
        }
        if (x[0] < 34028) {
            return 'float';
        }
        if (x[1] > 236692093846346) {
            return 'double';
        }
        if (x[1] < 236692093846346) {
            return 'float';
        }
        if (x[2] > 3374) {
            return 'double';
        }
        if (x[2] < 3374) {
            return 'float';
        }
        let limit = 607431768211455 + (sign ? 1 : 0);
        if (x[3] <= limit) {
            return 'float';
        }
        return 'double';
    }

    if (/^-?\d{0,38}\./.test(decimal_value))
        return 'float';
    return 'double'
}

/**
 * Convert an exponent-formatted number into a normalised decimal equivilent.
 * e.g '1.2345e3' -> '1234.5'
 *
 * If the number does not include an exponent, it is returned unchanged.
 * @param {string} n
 */
function decimalise_exponent_number(n) {
    const exp = n.match(/^(\D*)0*(\d+)(?:\.(\d+?)0*)?[eE]([+-]?)0*(\d+)(.*)/);
    if (!exp) {
        return n;
    }
    let i = exp[2], frac = (exp[3]||''), sign = exp[4]||'+', pow10 = parseInt(exp[5],10);
    if (pow10 > 0) {
        if (sign === '+') {
            let shifted_digits = Math.min(frac.length, pow10);
            i += frac.slice(0, shifted_digits);
            frac = frac.slice(shifted_digits);
            pow10 -= shifted_digits;
            i += '0'.repeat(pow10);
        } else {
            let shifted_digits = Math.min(i.length, pow10);
            frac = i.slice(-shifted_digits) + frac;      // move up to pow10 digits from i to frac
            i = i.slice(0, -shifted_digits);
            pow10 -= shifted_digits;
            frac = '0'.repeat(pow10) + frac;
        }
    }
    i = (i || '0').match(/^0*(.+)/)[1];
    if (/[1-9]/.test(frac)) i += `.${frac}`;
    return `${exp[1]}${i}${exp[6]}`
}

/**
 * @param {number|string} number
 */
function evaluate_number(number) {
    let n = number.toString();

    // normalise exponents into decimal form
    n = decimalise_exponent_number(n);

    let number_type, base = 10;
    const m = n.match(/^([+-]?)0([bBxX0-7])(.+)/);
    if (m) {
        switch (m[2]) {
            case 'b': base = 2; n = m[1] + m[3]; break;
            case 'x': base = 16; n = m[1] + m[3]; break;
            default: base = 8; break;
        }
    }

    if (base !== 16 && /[fFdD]$/.test(n)) {
        number_type = /[fF]$/.test(n) ? 'float' : 'double';
        n = n.slice(0, -1);
    } else if (/[lL]$/.test(n)) {
        number_type = 'long'
        n = n.slice(0, -1);
    } else {
        number_type = get_decimal_number_type(n);
    }

    let result;
    if (number_type === 'long') {
        result = hex_long(Long.fromString(n, false, base));
    } else if (/^[fd]/.test(number_type)) {
        result = (base === 10) ? parseFloat(n) : parseInt(n, base);
    } else {
        result = parseInt(n, base) | 0;
    }

    const iszero = /^[+-]?0+(\.0*)?$/.test(result.toString());

    return new LiteralValue(JavaType[number_type], result, iszero);
}

/**
 * @param {string} char 
 */
function evaluate_char(char) {
    // JDWP returns char values as uint16's, so we need to set the value as a number
    return new LiteralValue(JavaType.char, char.charCodeAt(0));
}

/**
 * Convert a value to a number
 * @param {DebuggerValue} local 
 */
function numberify(local) {
    if (JavaType.isFloat(local.type)) {
        return parseFloat(local.value);
    }
    const radix = JavaType.isLong(local.type) ? 16 : 10;
    return parseInt(local.value, radix);
}

/**
 * Convert a value to a string
 * @param {Debugger} dbgr 
 * @param {DebuggerValue} local 
 */
async function stringify(dbgr, local) {
    let s = '';
    switch(true) {
        case JavaType.isString(local.type):
            s = local.string;
            break;
        case JavaType.isPrimitive(local.type):
            s = local.value.toString();
            break;
        case local.hasnullvalue:
            s = '(null)';
            break;
        case JavaType.isReference(local.type):
            // call toString() on the object
            const str_literal = await dbgr.invokeToString(local.value, local.data.frame.threadid, local.type.signature);
            s = str_literal.string;
            break;
    }
    return s;
}

/**
 * @param {string} operator 
 * @param {boolean} [is_unary] 
 */
function invalid_operator(operator, is_unary = false) {
    return new Error(`Invalid ${is_unary ? 'type' : 'types'} for operator '${operator}'`);
}

/**
 * 
 */
function divide_by_zero() {
    return new Error('ArithmeticException: divide by zero');
}

/**
 * 
 * @param {*} lhs_local 
 * @param {*} rhs_local 
 * @param {string} operator 
 */
function evaluate_binary_boolean_expression(lhs_local, rhs_local, operator) {
    let a = lhs_local.value, b = rhs_local.value;
    switch (operator) {
        case '&': case '&&': a = a && b; break;
        case '|': case '||': a = a || b; break;
        case '^': a = !!(a ^ b); break;
        case '==': a = a === b; break;
        case '!=': a = a !== b; break;
        default: throw invalid_operator(operator);
    }
    return new LiteralValue(JavaType.boolean, a);
}

/**
 * 
 * @param {*} lhs_local 
 * @param {*} rhs_local 
 * @param {string} operator 
 */
function evaluate_binary_float_expression(lhs_local, rhs_local, operator) {
    /** @type {number|boolean} */
    let a = numberify(lhs_local), b = numberify(rhs_local);
    switch (operator) {
        case '+': a += b; break;
        case '-': a -= b; break;
        case '*': a *= b; break;
        case '/': a /= b; break;
        case '==': a = a === b; break;
        case '!=': a = a !== b; break;
        case '<': a = a < b; break;
        case '<=': a = a <= b; break;
        case '>': a = a > b; break;
        case '>=': a = a >= b; break;
        default: throw invalid_operator(operator);
    }
    /** @type {number|boolean|string} */
    let value = a, result_type = 'boolean'
    if (typeof a !== 'boolean') {
        result_type = (lhs_local.type.signature === 'D' || rhs_local.type.signature === 'D') ? 'double' : 'float';
    }
    return new LiteralValue(JavaType[result_type], value);
}


/**
 * 
 * @param {DebuggerValue} lhs 
 * @param {DebuggerValue} rhs 
 * @param {string} operator 
 */
function evaluate_binary_int_expression(lhs, rhs, operator) {
    /** @type {number|boolean} */
    let a = numberify(lhs), b = numberify(rhs);
    // dividend cannot be zero for / and %
    if (/[\/%]/.test(operator) && b === 0) {
        throw divide_by_zero();        
    }
    switch (operator) {
        case '+': a += b; break;
        case '-': a -= b; break;
        case '*': a *= b; break;
        case '/': a = Math.trunc(a / b); break;
        case '%': a %= b; break;
        case '<<': a <<= b; break;
        case '>>': a >>= b; break;
        case '>>>': a >>>= b; break;
        case '&': a &= b; break;
        case '|': a |= b; break;
        case '^': a ^= b; break;
        case '==': a = a === b; break;
        case '!=': a = a !== b; break;
        case '<': a = a < b; break;
        case '<=': a = a <= b; break;
        case '>': a = a > b; break;
        case '>=': a = a >= b; break;
        default: throw invalid_operator(operator);
    }
    /** @type {number|boolean|string} */
    let value = a, result_type = 'boolean'
    if (typeof a !== 'boolean') {
        result_type = 'int';
    }
    return new LiteralValue(JavaType[result_type], value);
}

/**
 * @param {DebuggerValue} lhs 
 * @param {DebuggerValue} rhs 
 * @param {string} operator 
 */
function evaluate_binary_long_expression(lhs, rhs, operator) {
    function longify(local) {
        const radix = JavaType.isLong(local.type) ? 16 : 10;
        return Long.fromString(`${local.value}`, false, radix);
    }

    /** @type {Long.Long|boolean} */
    let a = longify(lhs), b = longify(rhs);

    // dividend cannot be zero for / and %
    if (/[\/%]/.test(operator) && b.isZero()) {
        throw divide_by_zero();        
    }

    switch (operator) {
        case '+': a = a.add(b); break;
        case '-': a = a.subtract(b); break;
        case '*': a = a.multiply(b); break;
        case '/': a = a.divide(b); break;
        case '%': a = a.mod(b); break;
        case '<<': a = a.shl(b); break;
        case '>>': a = a.shr(b); break;
        case '>>>': a = a.shru(b); break;
        case '&': a = a.and(b); break;
        case '|': a = a.or(b); break;
        case '^': a = a.xor(b); break;
        case '==': a = a.eq(b); break;
        case '!=': a = !a.eq(b); break;
        case '<': a = a.lt(b); break;
        case '<=': a = a.lte(b); break;
        case '>': a = a.gt(b); break;
        case '>=': a = a.gte(b); break;
        default: throw invalid_operator(operator);
    }
    /** @type {boolean|Long.Long|string} */
    let value = a, result_type = 'boolean';
    if (typeof a !== 'boolean') {
        value = hex_long(a);
        result_type = 'long';
    }
    return new LiteralValue(JavaType[result_type], value);
}

/**
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {AndroidThread} thread 
 * @param {ParsedExpression} lhs 
 * @param {ParsedExpression} rhs 
 */
async function evaluate_assignment_expression(dbgr, locals, thread, lhs, rhs) {
    if (!(lhs instanceof RootExpression)) {
        throw new Error('Cannot assign value: left-hand-side is not a variable');
    }
    // if there are any qualifiers, the last qualifier must not be a method call
    const qualified_terms = lhs.qualified_terms.slice();
    const last_qualifier = qualified_terms.pop();
    if ((lhs.root_term_type !== 'ident') || (last_qualifier instanceof MethodCallExpression)) {
        throw new Error('Cannot assign value: left-hand-side is not a variable');
    }

    let lhs_value = locals.find(local => local.name === lhs.root_term);
    if (!lhs_value) {
        throw new Error(`Cannot assign value: variable '${lhs.root_term}' not found`);
    }
    // evaluate the qualified terms, until the last qualifier
    lhs_value = await evaluate_qualifiers(dbgr, locals, thread, lhs_value, qualified_terms);

    // evaluate the rhs
    const value = await evaluate_expression(dbgr, locals, thread, rhs);

    // assign the value
    if (last_qualifier instanceof ArrayIndexExpression) {
        const array_index = await evaluate_expression(dbgr, locals, thread, last_qualifier);
        await dbgr.setArrayElements(lhs_value, numberify(array_index), 1, JavaTaggedValue.from(value));
    }
    else if (last_qualifier instanceof MemberExpression) {
        const field = (await dbgr.findNamedFields(lhs_value.type.signature, last_qualifier.name, true))[0]
        await dbgr.setFieldValue(lhs_value, field, JavaTaggedValue.from(value));
    } else {
        //await dbgr.setLocalVariableValue(lhs_value, JavaTaggedValue.from(value));
    }

    return value;
}

/**
 * 
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {AndroidThread} thread 
 * @param {ParsedExpression} lhs 
 * @param {ParsedExpression} rhs 
 * @param {string} operator 
 */
async function evaluate_binary_expression(dbgr, locals, thread, lhs, rhs, operator) {

    if (operator === '=') {
        return evaluate_assignment_expression(dbgr, locals, thread, lhs, rhs);
    }

    const [lhs_value, rhs_value] = await Promise.all([
        evaluate_expression(dbgr, locals, thread, lhs),
        evaluate_expression(dbgr, locals, thread, rhs)
    ]);

    const types_key = `${lhs_value.type.signature}#${rhs_value.type.signature}`
    
    if (/[BCIJS]#[BCIJS]/.test(types_key) && /J/.test(types_key)) {
        // both expressions are integers - one is a long
        return evaluate_binary_long_expression(lhs_value, rhs_value, operator);
    }

    if (/[BCIS]#[BCIS]/.test(types_key)) {
        // both expressions are (non-long) integer types
        return evaluate_binary_int_expression(lhs_value, rhs_value, operator);
    }

    if (/[BCIJSFD]#[BCIJSFD]/.test(types_key)) {
        // both expressions are number types - one is a float or double
        return evaluate_binary_float_expression(lhs_value, rhs_value, operator);
    }

    if (/Z#Z/.test(types_key)) {
        // both expressions are boolean types
        return evaluate_binary_boolean_expression(lhs_value, rhs_value, operator);
    }

    // any + operator with a lhs of type String is coerced into a string append
    if (JavaType.isString(lhs_value.type) && operator === '+') {
        const rhs_str = await stringify(dbgr, rhs_value);
        return dbgr.createJavaStringLiteral(lhs_value.string + rhs_str, { israw: true });
    }

    // anything else is an invalid combination
    throw invalid_operator(operator);
}

/**
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {AndroidThread} thread
 * @param {string} operator 
 * @param {ParsedExpression} expr 
 */
async function evaluate_unary_expression(dbgr, locals, thread, operator, expr) {
    /** @type {DebuggerValue} */
    let local = await evaluate_expression(dbgr, locals, thread, expr);
    const key = `${operator}${local.type.signature}`;
    switch(true) {
        case /!Z/.test(key):
            return new LiteralValue(JavaType.boolean, !local.value);
        case /~C/.test(key):
            return evaluate_number(~local.value.charCodeAt(0));
        case /~[BIS]/.test(key):
            return evaluate_number(~local.value);
        case /~J/.test(key):
            return new LiteralValue(JavaType.long, hex_long(Long.fromString(local.value, false, 16).not()));
        case /-C/.test(key):
            return evaluate_number(-local.value.charCodeAt(0));
        case /-[BCIS]/.test(key):
            return evaluate_number(-local.value);
        case /-J/.test(key):
            return new LiteralValue(JavaType.long, hex_long(Long.fromString(local.value, false, 16).neg()));
        case /\+[BCIJS]/.test(key):
            return local;
        default:
            throw invalid_operator(operator, true);
    }
}

/**
 * 
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {string} identifier 
 * @returns {Promise<DebuggerValue>}
 */
async function evaluate_identifier(dbgr, locals, identifier) {
    const local = locals.find(l => l.name === identifier);
    if (local) {
        return local;
    }
    // if it's not a local, it could be the start of a package name or a type
    const classes = Array.from(dbgr.session.loadedClasses);
    return evaluate_qualified_type_name(dbgr, identifier, classes);
}

/**
 * 
 * @param {Debugger} dbgr 
 * @param {string} dotted_name
 * @param {string[]} classes
 */
async function evaluate_qualified_type_name(dbgr, dotted_name, classes) {
    const exact_class_matcher = new RegExp(`^L(java/lang/)?${dotted_name.replace(/\./g,'[$/]')};$`);
    const exact_class = classes.find(signature => exact_class_matcher.test(signature));
    if (exact_class) {
        return dbgr.getTypeValue(exact_class);
    }

    const class_matcher = new RegExp(`^L(java/lang/)?${dotted_name.replace('.','[$/]')}/`);
    const matching_classes = classes.filter(signature => class_matcher.test(signature));
    if (matching_classes.length === 0) {
        // the dotted name doesn't match any packages
        throw new Error(`'${dotted_name}' is not a package, type or variable name`);
    }
    return new DebuggerValue('package', null, dotted_name, true, false, 'package', {matching_classes});
}

/**
 * 
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {RootExpression} expr 
 * @returns {Promise<DebuggerValue>}
 */
async function evaluate_root_term(dbgr, locals, expr) {
    switch (expr.root_term_type) {
        case 'boolean':
            return new LiteralValue(JavaType.boolean, expr.root_term === 'true');
        case 'null':
            return LiteralValue.Null;
        case 'ident':
            return evaluate_identifier(dbgr, locals, expr.root_term);
        case 'hexint':
        case 'octint':
        case 'decint':
        case 'decfloat':
            return evaluate_number(expr.root_term);
        case 'char':
        case 'echar':
        case 'uchar':
            return evaluate_char(decodeJavaCharLiteral(expr.root_term))
        case 'string':
            // we must get the runtime to create string instances
            return await dbgr.createJavaStringLiteral(expr.root_term);
        default:
            return null;
    }
}

/**
 * 
 * @param {Debugger} dbgr 
 * @param {DebuggerValue} value 
 * @param {QualifierExpression[]} qualified_terms 
 * @returns {Promise<[number, DebuggerValue]>}
 */
async function evaluate_package_qualifiers(dbgr, value, qualified_terms) {
    let i = 0;
    for (;;) {
        // while the value is a package identifier...
        if (value.vtype !== 'package') {
            break;
        }
        // ... and the next term is a member expression...
        const term = qualified_terms[i];
        if (term instanceof MemberExpression) {
            // search for a valid type
            value = await evaluate_qualified_type_name(dbgr, `${value.value}.${term.name}`, value.data.matching_classes);
            i++;
            continue;
        }
        break;
    }
    if (value.vtype === 'package') {
        throw new Error('not available');
    }

    // return the number of qualified terms we used and the resulting value
    return [i, value];
}

/**
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {AndroidThread} thread 
 * @param {DebuggerValue} value 
 * @param {QualifierExpression[]} qualified_terms 
 */
async function evaluate_qualifiers(dbgr, locals, thread, value, qualified_terms) {
    let pkg_members;
    [pkg_members, value] = await evaluate_package_qualifiers(dbgr, value, qualified_terms);

    for (let i = pkg_members; i < qualified_terms.length; i++) {
        const term = qualified_terms[i];
        if (term instanceof MemberExpression) {
            // if this term is a member name, check if it's really a method call
            const next_term = qualified_terms[i + 1];
            if (next_term instanceof MethodCallExpression) {
                value = await evaluate_methodcall(dbgr, locals, thread, term.name, next_term, value);
                i++;
                continue;
            }
            value = await evaluate_member(dbgr, locals, thread, term, value);
            continue;
        }
        if (term instanceof ArrayIndexExpression) {
            value = await evaluate_array_element(dbgr, locals, thread, term.indexExpression, value);
            continue;
        }
        throw new Error('not available');
    }

    return value;
}

/**
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {AndroidThread} thread 
 * @param {RootExpression} expr 
 */
async function evaluate_root_expression(dbgr, locals, thread, expr) {
    let value = await evaluate_root_term(dbgr, locals, expr);
    if (!value || !value.valid) {
        throw new Error('not available');
    }

    // we've evaluated the root term variable - work out the rest
    value = await evaluate_qualifiers(dbgr, locals, thread, value, expr.qualified_terms);

    return value;
}

/**
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {AndroidThread} thread 
 * @param {ParsedExpression} expr 
 * @returns {Promise<DebuggerValue>}
 */
function evaluate_expression(dbgr, locals, thread, expr) {

    if (expr instanceof RootExpression) {
        return evaluate_root_expression(dbgr, locals, thread, expr);
    }
    if (expr instanceof BinaryOpExpression) {
        return evaluate_binary_expression(dbgr, locals, thread, expr.lhs, expr.rhs, expr.operator);
    }
    if (expr instanceof UnaryOpExpression) {
        return evaluate_unary_expression(dbgr, locals, thread, expr.operator, expr.rhs);
    }
    if (expr instanceof TypeCastExpression) {
        return evaluate_cast(dbgr, locals, thread, expr.cast_type, expr.rhs);
    }
    throw new Error('not available');
}


/**
 * 
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {AndroidThread} thread 
 * @param {ParsedExpression} index_expr 
 * @param {DebuggerValue} arr_local 
 */
async function evaluate_array_element(dbgr, locals, thread, index_expr, arr_local) {
    if (arr_local.type.signature[0] !== '[') {
        throw new Error(`TypeError: cannot apply array index to non-array type '${arr_local.type.typename}'`);
    }
    if (arr_local.hasnullvalue) {
        throw new Error('NullPointerException');
    }

    const idx_local = await evaluate_expression(dbgr, locals, thread, index_expr);
    if (!JavaType.isArrayIndex(idx_local.type)) {
        throw new Error('TypeError: array index is not an integer value');
    }

    const idx = numberify(idx_local);
    if (idx < 0 || idx >= arr_local.arraylen) {
        throw new Error(`BoundsError: array index (${idx}) out of bounds. Array length = ${arr_local.arraylen}`);
    }

    const element_values = await dbgr.getArrayElementValues(arr_local, idx, 1);
    return element_values[0];
}

/**
 * Build a regular expression which matches the possible parameter types for a value
 * @param {Debugger} dbgr 
 * @param {DebuggerValue} argument 
 */
async function getParameterSignatureRegex(dbgr, argument) {
    if (argument.type.signature == 'Lnull;') {
        return /^[LT[]/;   // null matches any reference type
    }
    if (/^L/.test(argument.type.signature)) {
        // for class reference types, retrieve a list of inherited classes 
        // since subclass instances can be passed as arguments
        const sigs = await dbgr.getClassInheritanceList(argument.type.signature);
        const re_sigs = sigs.map(signature => signature.replace(/[$]/g, '\\$'));
        return new RegExp(`(^${re_sigs.join('$)|(^')}$)`);
    }
    if (/^\[/.test(argument.type.signature)) {
        // for array types, only an exact array match or Object is allowed
        return new RegExp(`^(${argument.type.signature})|(${JavaType.Object.signature})$`);
    }
    switch(argument.type.signature) {
        case 'I':
            // match bytes/shorts/ints/longs/floats/doubles literals within range
            if (argument.value >= -128 && argument.value <= 127)
                return /^[BSIJFD]$/
            if (argument.value >= -32768 && argument.value <= 32767)
                return /^[SIJFD]$/
            return /^[IJFD]$/;
        case 'F':
            return /^[FD]$/;    // floats can be assigned to floats or doubles
        default:
            // anything else must be an exact match (no implicit cast is valid)
            return new RegExp(`^${argument.type.signature}$`);
    }
}

/**
 * @param {Debugger} dbgr 
 * @param {*} type 
 * @param {string} method_name 
 * @param {DebuggerValue[]} args
 */
async function findCompatibleMethod(dbgr, type, method_name, args) {
    // find any methods matching the member name with any parameters in the signature
    const methods = await dbgr.findNamedMethods(type.signature, method_name, /^/, false);
    if (!methods[0]) {
        throw new Error(`Error: method '${type.name}.${method_name}' not found`);
    }

    // filter the method based upon the types of parameters
    const arg_type_matchers = [];
    for (let arg of args) {
        arg_type_matchers.push(await getParameterSignatureRegex(dbgr, arg));
    }

    // find the first method where the argument types match the parameter types
    const matching_method = methods.find(method => {
        // extract a list of parameter types from the method signature
        const param_type_re = /\[*([BSIJFDCZ]|([LT][^;]+;))/g;
        const parameter_types = [];
        for (let x; x = param_type_re.exec(method.sig); ) {
            parameter_types.push(x[0]);
        }
        // the last type is always the return value
        parameter_types.pop();
        // check if the arguments and parameters match
        if (parameter_types.length !== arg_type_matchers.length) {
            return false;
        }
        // are there any argument types that don't match the corresponding parameter type?
        if (arg_type_matchers.find((m, idx) => !m.test(parameter_types[idx]))) {
            return false;
        }
        // we found a match
        return true;
    });

    if (!matching_method) {
        throw new Error(`Error: incompatible parameters for method '${method_name}'`);
    }

    return matching_method;
}

/**
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {AndroidThread} thread 
 * @param {string} method_name 
 * @param {MethodCallExpression} m 
 * @param {DebuggerValue} obj_local 
 */
async function evaluate_methodcall(dbgr, locals, thread, method_name, m, obj_local) {
    if (obj_local.hasnullvalue) {
        throw new Error('NullPointerException');
    }

    // evaluate any parameters
    const param_values = await Promise.all(m.arguments.map(arg => evaluate_expression(dbgr, locals, thread, arg)));

    // find a method in the object type matching the name and argument types
    const method = await findCompatibleMethod(dbgr, obj_local.type, method_name, param_values);

    return dbgr.invokeMethod(
        obj_local.value,
        thread.threadid,
        method,
        param_values
    );
}

/**
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {AndroidThread} thread
 * @param {MemberExpression} member 
 * @param {DebuggerValue} value 
 */
async function evaluate_member(dbgr, locals, thread, member, value) {
    if (!JavaType.isReference(value.type)) {
        throw new Error('TypeError: value is not a reference type');
    }
    if (value.hasnullvalue) {
        throw new Error('NullPointerException');
    }
    if (JavaType.isArray(value.type)) {
        // length is a 'fake' field of arrays, so special-case it
        if (member.name === 'length') {
            return evaluate_number(value.arraylen);
        }
    }
    // we also special-case :super (for object instances)
    if (member.name === ':super' && JavaType.isClass(value.type)) {
        return dbgr.getSuperInstance(value);
    }

    // check if the value is an enclosed type
    const enclosed_type = await dbgr.getTypeValue(`${value.type.signature.replace(/;$/,'')}$${member.name};`);
    if (enclosed_type.valid) {
        return enclosed_type;
    }

    // anything else must be a real field
    return dbgr.getFieldValue(value, member.name, true)
}


/**
 * @param {*} type 
 * @param {*} local 
 */
function incompatible_cast(type, local) {
    return new Error(`Incompatible cast from ${local.type.typename} to ${type}`);
}

/**
 * @param {Long.Long} value 
 * @param {8|16|32} bits 
 */
function signed_from_long(value, bits) {
    return (parseInt(value.toString(16).slice(-bits >> 3),16) << (32-bits)) >> (32-bits);
}

/**
 * @param {string} type 
 * @param {DebuggerValue} local 
 */
function cast_from_long(type, local) {
    const value = Long.fromString(local.value, true, 16);
    switch (true) {
        case (type === 'byte'):
            return evaluate_number(signed_from_long(value, 8));
        case (type === 'short'):
            return evaluate_number(signed_from_long(value, 16));
        case (type === 'int'):
            return evaluate_number(signed_from_long(value, 32));
        case (type === 'char'):
            return evaluate_char(String.fromCharCode(signed_from_long(value, 16) & 0xffff));
        case (type === 'float'):
            return evaluate_number(value.toSigned().toNumber() + 'F');
        case (type === 'double'):
            return evaluate_number(value.toSigned().toNumber() + 'D');
        default:
            throw incompatible_cast(type, local);
    }
}

/**
 * @param {Debugger} dbgr 
 * @param {DebuggerValue[]} locals 
 * @param {AndroidThread} thread
 * @param {string} cast_type 
 * @param {ParsedExpression} rhs 
 */
async function evaluate_cast(dbgr, locals, thread, cast_type, rhs) {
    let local = await evaluate_expression(dbgr, locals, thread, rhs);
    // check if a conversion is unnecessary
    if (cast_type === local.type.typename) {
        return local;
    }

    // boolean cannot be converted from anything else
    if (cast_type === 'boolean' || local.type.typename === 'boolean') {
        throw incompatible_cast(cast_type, local);
    }

    switch (true) {
        case local.type.typename === 'long':
            // conversion from long to something else
            local = cast_from_long(cast_type, local);
            break;
        case (cast_type === 'byte'):
            local = evaluate_number((local.value << 24) >> 24);
            break;
        case (cast_type === 'short'):
            local = evaluate_number((local.value << 16) >> 16);
            break;
        case (cast_type === 'int'):
            local = evaluate_number((local.value | 0));
            break;
        case (cast_type === 'long'):
            local = evaluate_number(local.value + 'L');
            break;
        case (cast_type === 'char'):
            local = evaluate_char(String.fromCharCode(local.value | 0));
            break;
        case (cast_type === 'float'):
        case (cast_type === 'double'):
            break;
        default:
            throw incompatible_cast(cast_type, local);
    }
    local.type = JavaType[cast_type];
    return local;
}

/**
 * @param {string} expression 
 * @param {AndroidThread} thread 
 * @param {DebuggerValue[]} locals 
 * @param {Debugger} dbgr 
 * @param {{allowFormatSpecifier:boolean}} [options]
 */
async function evaluate(expression, thread, locals, dbgr, options) {
    D('evaluate: ' + expression);
    await dbgr.ensureConnected();

    // the thread must be in the paused state
    if (thread && !thread.paused) {
        throw new Error('not available');
    }

    // parse the expression
    const e = new ExpressionText(expression.trim())
    if (!e.expr) {
        return null;
    }
    const parsed_expression = parse_expression(e);

    let display_format = null;
    if (options && options.allowFormatSpecifier) {
        // look for formatting specifiers in the form of ',<x>'
        // ref: https://docs.microsoft.com/en-us/visualstudio/debugger/format-specifiers-in-cpp
        const df_match = e.expr.match(/^,([doc!]|[xX]b?|bb?|sb?)/);
        if (df_match) {
            display_format = df_match[1];
            e.expr = e.expr.slice(df_match[0].length)
        }
    }

    // if there's anything left, it's an error
    if (!parsed_expression || e.expr) {
        // the expression is not well-formed
        throw new Error(`Invalid expression: ${expression.trim()}`);
    }

    // the expression is well-formed - start the (asynchronous) evaluation
    const value = await evaluate_expression(dbgr, locals, thread, parsed_expression);

    return {
        value,
        display_format,
    }
}

module.exports = {
    evaluate,
}
