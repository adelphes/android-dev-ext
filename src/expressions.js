'use strict'
const Long = require('long');
const $ = require('./jq-promise');
const { D } = require('./util');
const { JTYPES, exmsg_var_name, decode_char, createJavaString } = require('./globals');

/*
    Asynchronously evaluate an expression
*/
exports.evaluate = function(expression, thread, locals, vars, dbgr) {
    D('evaluate: ' + expression);

    const reject_evaluation = (msg) => $.Deferred().rejectWith(this, [new Error(msg)]);
    const resolve_evaluation = (value, variablesReference) => $.Deferred().resolveWith(this, [value, variablesReference]);

    if (thread && !thread.paused)
        return reject_evaluation('not available');

    // special case for evaluating exception messages
    // - this is called if the user tries to evaluate ':msg' from the locals
    if (expression === exmsg_var_name) {
        if (thread && thread.paused.last_exception && thread.paused.last_exception.cached) {
            var msglocal = thread.paused.last_exception.cached.find(v => v.name === exmsg_var_name);
            if (msglocal) {
                return resolve_evaluation(vars._local_to_variable(msglocal).value);
            }
        }
        return reject_evaluation('not available');
    }

    const parse_array_or_fncall = function (e) {
        var arg, res = { arr: [], call: null };
        // pre-call array indexes
        while (e.expr[0] === '[') {
            e.expr = e.expr.slice(1).trim();
            if ((arg = parse_expression(e)) === null) return null;
            res.arr.push(arg);
            if (e.expr[0] !== ']') return null;
            e.expr = e.expr.slice(1).trim();
        }
        if (res.arr.length) return res;
        // method call
        if (e.expr[0] === '(') {
            res.call = []; e.expr = e.expr.slice(1).trim();
            if (e.expr[0] !== ')') {
                for (; ;) {
                    if ((arg = parse_expression(e)) === null) return null;
                    res.call.push(arg);
                    if (e.expr[0] === ')') break;
                    if (e.expr[0] !== ',') return null;
                    e.expr = e.expr.slice(1).trim();
                }
            }
            e.expr = e.expr.slice(1).trim();
            // post-call array indexes
            while (e.expr[0] === '[') {
                e.expr = e.expr.slice(1).trim();
                if ((arg = parse_expression(e)) === null) return null;
                res.arr.push(arg);
                if (e.expr[0] !== ']') return null;
                e.expr = e.expr.slice(1).trim();
            }
        }
        return res;
    }
    const parse_expression_term = function (e) {
        if (e.expr[0] === '(') {
            e.expr = e.expr.slice(1).trim();
            var subexpr = { expr: e.expr };
            var res = parse_expression(subexpr);
            if (res) {
                if (subexpr.expr[0] !== ')') return null;
                e.expr = subexpr.expr.slice(1).trim();
                if (/^(int|long|byte|short|double|float|char|boolean)$/.test(res.root_term) && !res.members.length && !res.array_or_fncall.call && !res.array_or_fncall.arr.length) {
                    // primitive typecast
                    var castexpr = parse_expression_term(e);
                    if (castexpr) castexpr.typecast = res.root_term;
                    res = castexpr;
                }
            }
            return res;
        }
        var unop = e.expr.match(/^(?:(!\s?)+|(~\s?)+|(?:([+-]\s?)+(?![\d.])))/);
        if (unop) {
            var op = unop[0].replace(/\s/g, '');
            e.expr = e.expr.slice(unop[0].length).trim();
            var res = parse_expression_term(e);
            if (res) {
                for (var i = op.length - 1; i >= 0; --i)
                    res = { operator: op[i], rhs: res };
            }
            return res;
        }
        var root_term = e.expr.match(/^(?:(true(?![\w$]))|(false(?![\w$]))|(null(?![\w$]))|([a-zA-Z_$][a-zA-Z0-9_$]*)|([+-]?0x[0-9a-fA-F]+[lL]?)|([+-]?0[0-7]+[lL]?)|([+-]?\d+\.\d+(?:[eE][+-]?\d+)?[fFdD]?)|([+-]?\d+[lL]?)|('[^\\']')|('\\[bfrntv0]')|('\\u[0-9a-fA-F]{4}')|("[^"]*"))/);
        if (!root_term) return null;
        var res = {
            root_term: root_term[0],
            root_term_type: ['boolean', 'boolean', 'null', 'ident', 'hexint', 'octint', 'decfloat', 'decint', 'char', 'echar', 'uchar', 'string'][[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].find(x => root_term[x]) - 1],
            array_or_fncall: null,
            members: [],
            typecast: ''
        }
        e.expr = e.expr.slice(res.root_term.length).trim();
        if ((res.array_or_fncall = parse_array_or_fncall(e)) === null) return null;
        // the root term is not allowed to be a method call
        if (res.array_or_fncall.call) return null;
        while (e.expr[0] === '.') {
            // member expression
            e.expr = e.expr.slice(1).trim();
            var m, member_name = e.expr.match(/^:?[a-zA-Z_$][a-zA-Z0-9_$]*/);   // allow : at start for :super and :msg
            if (!member_name) return null;
            res.members.push(m = { member: member_name[0], array_or_fncall: null })
            e.expr = e.expr.slice(m.member.length).trim();
            if ((m.array_or_fncall = parse_array_or_fncall(e)) === null) return null;
        }
        return res;
    }
    const prec = {
        '*': 1, '%': 1, '/': 1,
        '+': 2, '-': 2,
        '<<': 3, '>>': 3, '>>>': 3,
        '<': 4, '>': 4, '<=': 4, '>=': 4, 'instanceof': 4,
        '==': 5, '!=': 5,
        '&': 6, '^': 7, '|': 8, '&&': 9, '||': 10, '?': 11,
    }
    const parse_expression = function (e) {
        var res = parse_expression_term(e);

        if (!e.currprec) e.currprec = [12];
        for (; ;) {
            var binary_operator = e.expr.match(/^([/%*&|^+-]=|<<=|>>>?=|[><!=]=|=|<<|>>>?|[><]|&&|\|\||[/%*&|^]|\+(?=[^+]|[+][\w\d.])|\-(?=[^-]|[-][\w\d.])|instanceof\b|\?)/);
            if (!binary_operator) break;
            var precdiff = (prec[binary_operator[0]] || 12) - e.currprec[0];
            if (precdiff > 0) {
                // bigger number -> lower precendence -> end of (sub)expression
                break;
            }
            if (precdiff === 0 && binary_operator[0] !== '?') {
                // equal precedence, ltr evaluation
                break;
            }
            // higher or equal precendence
            e.currprec.unshift(e.currprec[0] + precdiff);
            e.expr = e.expr.slice(binary_operator[0].length).trim();
            // current or higher precendence
            if (binary_operator[0] === '?') {
                res = { condition: res, operator: binary_operator[0], ternary_true: null, ternary_false: null };
                res.ternary_true = parse_expression(e);
                if (e.expr[0] === ':') {
                    e.expr = e.expr.slice(1).trim();
                    res.ternary_false = parse_expression(e);
                }
            } else {
                res = { lhs: res, operator: binary_operator[0], rhs: parse_expression(e) };
            }
            e.currprec.shift();
        }
        return res;
    }
    const hex_long = long => ('000000000000000' + long.toUnsigned().toString(16)).slice(-16);
    const evaluate_number = (n) => {
        n += '';
        var numtype, m = n.match(/^([+-]?)0([bBxX0-7])(.+)/), base = 10;
        if (m) {
            switch (m[2]) {
                case 'b': base = 2; n = m[1] + m[3]; break;
                case 'x': base = 16; n = m[1] + m[3]; break;
                default: base = 8; break;
            }
        }
        if (base !== 16 && /[fFdD]$/.test(n)) {
            numtype = /[fF]$/.test(n) ? 'float' : 'double';
            n = n.slice(0, -1);
        } else if (/[lL]$/.test(n)) {
            numtype = 'long'
            n = n.slice(0, -1);
        } else {
            numtype = /\./.test(n) ? 'double' : 'int';
        }
        if (numtype === 'long') n = hex_long(Long.fromString(n, false, base));
        else if (/^[fd]/.test(numtype)) n = (base === 10) ? parseFloat(n) : parseInt(n, base);
        else n = parseInt(n, base) | 0;

        const iszero = /^[+-]?0+(\.0*)?$/.test(n);
        return { vtype: 'literal', name: '', hasnullvalue: iszero, type: JTYPES[numtype], value: n, valid: true };
    }
    const evaluate_char = (char) => {
        return { vtype: 'literal', name: '', char: char, hasnullvalue: false, type: JTYPES.char, value: char.charCodeAt(0), valid: true };
    }
    const numberify = (local) => {
        //if (local.type.signature==='C') return local.char.charCodeAt(0);
        if (/^[FD]$/.test(local.type.signature))
            return parseFloat(local.value);
        if (local.type.signature === 'J')
            return parseInt(local.value, 16);
        return parseInt(local.value, 10);
    }
    const stringify = (local) => {
        var s;
        if (JTYPES.isString(local.type)) s = local.string;
        else if (JTYPES.isChar(local.type)) s = local.char;
        else if (JTYPES.isPrimitive(local.type)) s = '' + local.value;
        else if (local.hasnullvalue) s = '(null)';
        if (typeof s === 'string')
            return $.Deferred().resolveWith(this, [s]);
        return dbgr.invokeToString(local.value, local.info.frame.threadid, local.type.signature)
            .then(s => s.string);
    }
    const evaluate_expression = (expr) => {
        var q = $.Deferred(), local;
        if (expr.operator) {
            const invalid_operator = (unary) => reject_evaluation(`Invalid ${unary ? 'type' : 'types'} for operator '${expr.operator}'`),
                divide_by_zero = () => reject_evaluation('ArithmeticException: divide by zero');
            var lhs_local;
            return !expr.lhs
                ? // unary operator
                evaluate_expression(expr.rhs)
                    .then(rhs_local => {
                        if (expr.operator === '!' && JTYPES.isBoolean(rhs_local.type)) {
                            rhs_local.value = !rhs_local.value;
                            return rhs_local;
                        }
                        else if (expr.operator === '~' && JTYPES.isInteger(rhs_local.type)) {
                            switch (rhs_local.type.typename) {
                                case 'long': rhs_local.value = rhs_local.value.replace(/./g, c => (15 - parseInt(c, 16)).toString(16)); break;
                                default: rhs_local = evaluate_number('' + ~rhs_local.value); break;
                            }
                            return rhs_local;
                        }
                        else if (/[+-]/.test(expr.operator) && JTYPES.isInteger(rhs_local.type)) {
                            if (expr.operator === '+') return rhs_local;
                            switch (rhs_local.type.typename) {
                                case 'long': rhs_local.value = hex_long(Long.fromString(rhs_local.value, false, 16).neg()); break;
                                default: rhs_local = evaluate_number('' + (-rhs_local.value)); break;
                            }
                            return rhs_local;
                        }
                        return invalid_operator('unary');
                    })
                : // binary operator
                evaluate_expression(expr.lhs)
                    .then(x => (lhs_local = x) && evaluate_expression(expr.rhs))
                    .then(rhs_local => {
                        if ((lhs_local.type.signature === 'J' && JTYPES.isInteger(rhs_local.type))
                            || (rhs_local.type.signature === 'J' && JTYPES.isInteger(lhs_local.type))) {
                            // one operand is a long, the other is an integer -> the result is a long
                            var a, b, lbase, rbase;
                            lbase = lhs_local.type.signature === 'J' ? 16 : 10;
                            rbase = rhs_local.type.signature === 'J' ? 16 : 10;
                            a = Long.fromString('' + lhs_local.value, false, lbase);
                            b = Long.fromString('' + rhs_local.value, false, rbase);
                            switch (expr.operator) {
                                case '+': a = a.add(b); break;
                                case '-': a = a.subtract(b); break;
                                case '*': a = a.multiply(b); break;
                                case '/': if (!b.isZero()) { a = a.divide(b); break } return divide_by_zero();
                                case '%': if (!b.isZero()) { a = a.mod(b); break; } return divide_by_zero();
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
                                default: return invalid_operator();
                            }
                            if (typeof a === 'boolean')
                                return { vtype: 'literal', name: '', hasnullvalue: false, type: JTYPES.boolean, value: a, valid: true };
                            return { vtype: 'literal', name: '', hasnullvalue: false, type: JTYPES.long, value: hex_long(a), valid: true };
                        }
                        else if (JTYPES.isInteger(lhs_local.type) && JTYPES.isInteger(rhs_local.type)) {
                            // both are (non-long) integer types
                            var a = numberify(lhs_local), b = numberify(rhs_local);
                            switch (expr.operator) {
                                case '+': a += b; break;
                                case '-': a -= b; break;
                                case '*': a *= b; break;
                                case '/': if (b) { a = Math.trunc(a / b); break } return divide_by_zero();
                                case '%': if (b) { a %= b; break; } return divide_by_zero();
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
                                default: return invalid_operator();
                            }
                            if (typeof a === 'boolean')
                                return { vtype: 'literal', name: '', hasnullvalue: false, type: JTYPES.boolean, value: a, valid: true };
                            return { vtype: 'literal', name: '', hasnullvalue: false, type: JTYPES.int, value: '' + a, valid: true };
                        }
                        else if (JTYPES.isNumber(lhs_local.type) && JTYPES.isNumber(rhs_local.type)) {
                            var a = numberify(lhs_local), b = numberify(rhs_local);
                            switch (expr.operator) {
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
                                default: return invalid_operator();
                            }
                            if (typeof a === 'boolean')
                                return { vtype: 'literal', name: '', hasnullvalue: false, type: JTYPES.boolean, value: a, valid: true };
                            // one of them must be a float or double
                            var result_type = 'float double'.split(' ')[Math.max("FD".indexOf(lhs_local.type.signature), "FD".indexOf(rhs_local.type.signature))];
                            return { vtype: 'literal', name: '', hasnullvalue: false, type: JTYPES[result_type], value: '' + a, valid: true };
                        }
                        else if (lhs_local.type.signature === 'Z' && rhs_local.type.signature === 'Z') {
                            // boolean operands
                            var a = lhs_local.value, b = rhs_local.value;
                            switch (expr.operator) {
                                case '&': case '&&': a = a && b; break;
                                case '|': case '||': a = a || b; break;
                                case '^': a = !!(a ^ b); break;
                                case '==': a = a === b; break;
                                case '!=': a = a !== b; break;
                                default: return invalid_operator();
                            }
                            return { vtype: 'literal', name: '', hasnullvalue: false, type: JTYPES.boolean, value: a, valid: true };
                        }
                        else if (expr.operator === '+' && JTYPES.isString(lhs_local.type)) {
                            return stringify(rhs_local).then(rhs_str => createJavaString(dbgr, lhs_local.string + rhs_str, { israw: true }));
                        }
                        return invalid_operator();
                    });
        }
        switch (expr.root_term_type) {
            case 'boolean':
                local = { vtype: 'literal', name: '', hasnullvalue: false, type: JTYPES.boolean, value: expr.root_term !== 'false', valid: true };
                break;
            case 'null':
                const nullvalue = '0000000000000000'; // null reference value
                local = { vtype: 'literal', name: '', hasnullvalue: true, type: JTYPES.null, value: nullvalue, valid: true };
                break;
            case 'ident':
                local = locals && locals.find(l => l.name === expr.root_term);
                break;
            case 'hexint':
            case 'octint':
            case 'decint':
            case 'decfloat':
                local = evaluate_number(expr.root_term);
                break;
            case 'char':
            case 'echar':
            case 'uchar':
                local = evaluate_char(decode_char(expr.root_term.slice(1, -1)))
                break;
            case 'string':
                // we must get the runtime to create string instances
                q = createJavaString(dbgr, expr.root_term);
                local = { valid: true };   // make sure we don't fail the evaluation
                break;
        }
        if (!local || !local.valid) return reject_evaluation('not available');
        // we've got the root term variable - work out the rest
        q = expr.array_or_fncall.arr.reduce((q, index_expr) => {
            return q.then(function (index_expr, local) { return evaluate_array_element.call(this, index_expr, local) }.bind(this, index_expr));
        }, q);
        q = expr.members.reduce((q, m) => {
            return q.then(function (m, local) { return evaluate_member.call(this, m, local) }.bind(this, m));
        }, q);
        if (expr.typecast) {
            q = q.then(function (type, local) { return evaluate_cast.call(this, type, local) }.bind(this, expr.typecast))
        }
        // if it's a string literal, we are already waiting for the runtime to create the string
        // - otherwise, start the evalaution...
        if (expr.root_term_type !== 'string')
            q.resolveWith(this, [local]);
        return q;
    }
    const evaluate_array_element = (index_expr, arr_local) => {
        if (arr_local.type.signature[0] !== '[') return reject_evaluation(`TypeError: cannot apply array index to non-array type '${arr_local.type.typename}'`);
        if (arr_local.hasnullvalue) return reject_evaluation('NullPointerException');
        return evaluate_expression(index_expr)
            .then(function (arr_local, idx_local) {
                if (!JTYPES.isInteger(idx_local.type)) return reject_evaluation('TypeError: array index is not an integer value');
                var idx = numberify(idx_local);
                if (idx < 0 || idx >= arr_local.arraylen) return reject_evaluation(`BoundsError: array index (${idx}) out of bounds. Array length = ${arr_local.arraylen}`);
                return dbgr.getarrayvalues(arr_local, idx, 1)
            }.bind(this, arr_local))
            .then(els => els[0])
    }
    const evaluate_methodcall = (m, obj_local) => {
        // until we can figure out why method invokes with parameters crash the debugger, disallow parameterised calls
        if (m.array_or_fncall.call.length)
            return reject_evaluation('Error: method calls with parameter values are not supported');
            
        // find any methods matching the member name with any parameters in the signature
        return dbgr.findNamedMethods(obj_local.type.signature, m.member, /^/)
            .then(methods => {
                if (!methods[0])
                    return reject_evaluation(`Error: method '${m.member}()' not found`);
                // evaluate any parameters (and wait for the results)
                return $.when({methods},...m.array_or_fncall.call.map(evaluate_expression));
            })
            .then((x,...paramValues) => {
                // filter the method based upon the types of parameters - note that null types and integer literals can match multiple types
                paramValues = paramValues = paramValues.map(p => p[0]);
                var matchers = paramValues.map(p => {
                    switch(true) {
                        case p.type.signature === 'I':
                            // match bytes/shorts/ints/longs/floats/doubles within range
                            if (p.value >= -128 && p.value <= 127) return /^[BSIJFD]$/
                            if (p.value >= -32768 && p.value <= 32767) return /^[SIJFD]$/
                            return /^[IJFD]$/;
                        case p.type.signature === 'F':
                            return /^[FD]$/;
                        case p.type.signature === 'Lnull;':
                            return /^[LT\[]/;   // any reference type
                        default:
                            // anything else must be an exact signature match (for now - in reality we should allow subclassed type)
                            return new RegExp(`^${p.type.signature.replace(/[$]/g,x=>'\\'+x)}$`);
                    }
                });
                var methods = x.methods.filter(m => {
                    // extract a list of parameter types
                    var paramtypere = /\[*([BSIJFDCZ]|([LT][^;]+;))/g;
                    for (var x, ptypes=[]; x = paramtypere.exec(m.sig); ) {
                        ptypes.push(x[0]);
                    }
                    // the last paramter type is the return value
                    ptypes.pop();
                    // check if they match
                    if (ptypes.length !== paramValues.length)
                        return;
                    return matchers.filter(m => {
                        return !m.test(ptypes.shift())
                    }).length === 0;
                });
                if (!methods[0])
                    return reject_evaluation(`Error: incompatible parameters for method '${m.member}'`);
                // convert the parameters to exact debugger-compatible values
                paramValues = paramValues.map(p => {
                    if (p.type.signature.length === 1)
                        return { type: p.type.typename, value: p.value};
                    return { type: 'oref', value: p.value };
                })
                return dbgr.invokeMethod(obj_local.value, thread.threadid, obj_local.type.signature, m.member, methods[0].genericsig || methods[0].sig, paramValues, {});
            });
    }
    const evaluate_member = (m, obj_local) => {
        if (!JTYPES.isReference(obj_local.type)) return reject_evaluation('TypeError: value is not a reference type');
        if (obj_local.hasnullvalue) return reject_evaluation('NullPointerException');
        var chain;
        if (m.array_or_fncall.call) {
            chain = evaluate_methodcall(m, obj_local);
        }
        // length is a 'fake' field of arrays, so special-case it
        else if (JTYPES.isArray(obj_local.type) && m.member === 'length') {
            chain = $.Deferred().resolve(evaluate_number(obj_local.arraylen));
        }
        // we also special-case :super (for object instances)
        else if (JTYPES.isObject(obj_local.type) && m.member === ':super') {
            chain = dbgr.getsuperinstance(obj_local);
        }
        // anything else must be a real field
        else {
            chain = dbgr.getFieldValue(obj_local, m.member, true)
        }

        return chain.then(local => {
            if (m.array_or_fncall.arr.length) {
                var q = $.Deferred();
                m.array_or_fncall.arr.reduce((q, index_expr) => {
                    return q.then(function (index_expr, local) { return evaluate_array_element(index_expr, local) }.bind(this, index_expr));
                }, q);
                return q.resolveWith(this, [local]);
            }
        });
    }
    const evaluate_cast = (type, local) => {
        if (type === local.type.typename) return local;
        const incompatible_cast = () => reject_evaluation(`Incompatible cast from ${local.type.typename} to ${type}`);
        // boolean cannot be converted from anything else
        if (type === 'boolean' || local.type.typename === 'boolean') return incompatible_cast();
        if (local.type.typename === 'long') {
            // long to something else
            var value = Long.fromString(local.value, true, 16);
            switch (true) {
                case (type === 'byte'): local = evaluate_number((parseInt(value.toString(16).slice(-2), 16) << 24) >> 24); break;
                case (type === 'short'): local = evaluate_number((parseInt(value.toString(16).slice(-4), 16) << 16) >> 16); break;
                case (type === 'int'): local = evaluate_number((parseInt(value.toString(16).slice(-8), 16) | 0)); break;
                case (type === 'char'): local = evaluate_char(String.fromCharCode(parseInt(value.toString(16).slice(-4), 16))); break;
                case (type === 'float'): local = evaluate_number(value.toSigned().toNumber() + 'F'); break;
                case (type === 'double'): local = evaluate_number(value.toSigned().toNumber() + 'D'); break;
                default: return incompatible_cast();
            }
        } else {
            switch (true) {
                case (type === 'byte'): local = evaluate_number((local.value << 24) >> 24); break;
                case (type === 'short'): local = evaluate_number((local.value << 16) >> 16); break;
                case (type === 'int'): local = evaluate_number((local.value | 0)); break;
                case (type === 'long'): local = evaluate_number(local.value + 'L'); break;
                case (type === 'char'): local = evaluate_char(String.fromCharCode(local.value | 0)); break;
                case (type === 'float'): break;
                case (type === 'double'): break;
                default: return incompatible_cast();
            }
        }
        local.type = JTYPES[type];
        return local;
    }

    var e = { expr: expression.trim() };
    var parsed_expression = parse_expression(e);
    // if there's anything left, it's an error
    if (parsed_expression && !e.expr) {
        // the expression is well-formed - start the (asynchronous) evaluation
        return evaluate_expression(parsed_expression)
            .then(local => {
                var v = vars._local_to_variable(local);
                return resolve_evaluation(v.value, v.variablesReference);
            });
    }

    // the expression is not well-formed
    return reject_evaluation('not available');
}
