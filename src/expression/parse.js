/**
 * Operator precedence levels.
 * Lower number = higher precedence.
 * Operators with equal precedence are evaluated left-to-right.
 */
const operator_precedences = {
    '*': 1, '%': 1, '/': 1,
    '+': 2, '-': 2,
    '<<': 3, '>>': 3, '>>>': 3,
    '<': 4, '>': 4, '<=': 4, '>=': 4, 'instanceof': 4,
    '==': 5, '!=': 5,
    '&': 6, '^': 7, '|': 8,
    '&&': 9, '||': 10,
    '?': 11,
    '=': 12,
}

const lowest_precedence = 13;

class ExpressionText {
    /**
     * @param {string} text 
     */
    constructor(text) {
        this.expr = text;
        this.precedence_stack = [lowest_precedence];
    }

    get current_precedence() {
        return this.precedence_stack[0];
    }
}

class ParsedExpression {
}

class RootExpression extends ParsedExpression {
    /**
     * @param {string} root_term 
     * @param {string} root_term_type 
     * @param {QualifierExpression[]} qualified_terms 
     */
    constructor(root_term, root_term_type, qualified_terms) {
        super();
        this.root_term = root_term;
        this.root_term_type = root_term_type;
        this.qualified_terms = qualified_terms;
    }
}

class TypeCastExpression extends ParsedExpression {
    /**
     * 
     * @param {ParsedExpression} cast_type 
     * @param {ParsedExpression} rhs 
     */
    constructor(cast_type, rhs) {
        super();
        this.cast_type = cast_type;
        this.rhs = rhs;
    }
}

class BinaryOpExpression extends ParsedExpression {
    /**
     * @param {ParsedExpression} lhs 
     * @param {string} operator 
     * @param {ParsedExpression} rhs 
     */
    constructor(lhs, operator, rhs) {
        super();
        this.lhs = lhs;
        this.operator = operator;
        this.rhs = rhs;
    }
}

class UnaryOpExpression extends ParsedExpression {
    /**
     * @param {string} operator 
     * @param {ParsedExpression} rhs 
     */
    constructor(operator, rhs) {
        super();
        this.operator = operator;
        this.rhs = rhs;
    }
}

class IncOpExpression extends ParsedExpression {
    /**
     * @param {'e++'|'e--'|'++e'|'--e'} which 
     * @param {ParsedExpression} expression 
     */
    constructor(which, expression) {
        super();
        this.which = which;
        this.expression = expression;
    }
}

class TernaryExpression extends ParsedExpression {

    /**
     * @param {ParsedExpression} condition 
     */
    constructor(condition) {
        super();
        this.condition = condition;
        /** @type {ParsedExpression} */
        this.ternary_true = null;
        /** @type {ParsedExpression} */
        this.ternary_false = null;
    }
}

class QualifierExpression extends ParsedExpression {

}

class ArrayIndexExpression extends QualifierExpression {
    /**
     * @param {ParsedExpression} index_expression 
     */
    constructor(index_expression) {
        super();
        this.indexExpression = index_expression;
    }
}

class MethodCallExpression extends QualifierExpression {
    /** @type {ParsedExpression[]} */
    arguments = [];
}

class MemberExpression extends QualifierExpression {
    /**
     * @param {string} name 
     */
    constructor(name) {
        super();
        this.name = name;
    }
}

class BracketedExpression extends ParsedExpression {
    constructor(expression, qualified_terms) {
        super();
        this.expression = expression;
        this.qualified_terms = qualified_terms;
    }
}

class ArrayLiteralExpression extends ParsedExpression {
    elements = [];
}

class ParsedNewExpression extends ParsedExpression {}

class NewObjectExpression extends ParsedNewExpression {
    /**
     * @param {RootExpression} ctr_call 
     * @param {QualifierExpression[]} post_ctr_qualifiers
     * @param {string} method_body
     */
    constructor(ctr_call, post_ctr_qualifiers, method_body) {
        super();
        this.ctr_call = ctr_call;
        this.qualified_terms = post_ctr_qualifiers;
        this.method_body = method_body;
    }
}

class NewArrayExpression extends ParsedNewExpression {
    /**
     * @param {RootExpression} type 
     * @param {ArrayIndexExpression[]} arrdim_initers
     * @param {QualifierExpression[]} post_ctr_qualifiers
     */
    constructor(type, arrdim_initers, post_ctr_qualifiers) {
        super();
        this.type = type;
        this.arrdim_initers = arrdim_initers;
        this.post_ctr_qualifiers = post_ctr_qualifiers;
    }
}

/**
 * Remove characters from the expression followed by any leading whitespace/comments
 * @param {ExpressionText} e
 * @param {number|string} length_or_text
 */
function strip(e, length_or_text) {
    if (typeof length_or_text === 'string') {
        if (!e.expr.startsWith(length_or_text)) {
            return false;
        }
        length_or_text = length_or_text.length;
    }
    e.expr = e.expr.slice(length_or_text).trimLeft();
    for (;;) {
        const comment = e.expr.match(/(^\/\/.+)|(^\/\*[\d\D]*?\*\/)/);
        if (!comment) break;
        e.expr = e.expr.slice(comment[0].length).trimLeft();
    }
    return true;
}

/**
 * @param {ExpressionText} e
 * @returns {(MemberExpression|ArrayIndexExpression|MethodCallExpression)[]}
 */
function parse_qualified_terms(e) {
    const res = [];
    while (/^[([.]/.test(e.expr)) {
        if (strip(e, '.')) {
            // member access
            const name_match = e.expr.match(/^:?[a-zA-Z_$][a-zA-Z0-9_$]*/);   // allow : at start for :super and :msg
            if (!name_match) {
                return null;
            }
            const member = new MemberExpression(name_match[0]);
            strip(e, member.name.length)
            res.push(member);
        }
        else if (strip(e, '(')) {
            // method call
            const call = new MethodCallExpression();
            if (!strip(e, ')')) {
                for (let arg; ;) {
                    if ((arg = parse_expression(e)) === null) {
                        return null;
                    }
                    call.arguments.push(arg);
                    if (strip(e, ',')) continue;
                    if (strip(e, ')')) break;
                    return null;
                }
            }
            res.push(call);
        }
        else if (strip(e, '[')) {
            // array index
            const index_expr = parse_expression(e);
            if (index_expr === null) {
                return null;
            }
            if (!strip(e, ']')) {
                return null;
            }
            res.push(new ArrayIndexExpression(index_expr));
        }
    }
    return res;
}

/**
 * @param {ExpressionText} e
 */
function parseBracketOrCastExpression(e) {
    if (!strip(e, '(')) {
        return null;
    }
    let res = parse_expression(e);
    if (!res) {
        return null;
    }
    if (!strip(e, ')')) {
        return null;
    }
    // note - a bracketed expression followed by another bracketed expression is assumed to be a cast:
    // double d = (double)(float)5; - is ok
    // XYZ xyz = (new XYZ)(1,2,3); - nope
    // - this will still need to be resolved for +/- e.g (int)+5 vs (some.field)+5
    if (/^[\w"'(!~]/.test(e.expr)) {
        // typecast
        const castexpr = parse_expression(e);
        if (!castexpr) {
            return null;
        }
        return new TypeCastExpression(res, castexpr);
    }

    const qt = parse_qualified_terms(e);
    return new BracketedExpression(res, qt);
}

/**
 * 
 * @param {ExpressionText} e 
 * @param {string} unop 
 */
function parseUnaryExpression(e, unop) {
    strip(e, unop.length);
    let res = parse_expression_term(e);
    if (!res) {
        return null;
    }
    const op = unop.replace(/\s+/g, '');
    for (let i = op.length - 1; i >= 0; --i) {
        res = new UnaryOpExpression(op[i], res);
    }
    return res;
}

/**
 * @param {ExpressionText} e 
 * @param {RootExpression} ctr 
 * @param {QualifierExpression[]} ctr_qualifiers
 * @param {QualifierExpression[]} post_ctr_qualifiers
 */
function parseNewObjectExpression(e, ctr, ctr_qualifiers, post_ctr_qualifiers) {
    const ctr_call = new RootExpression(ctr.root_term, ctr.root_term_type, ctr_qualifiers);
    let method_body = null;
    if (!post_ctr_qualifiers.length) {
        // if there are no qualifiers following the constructor, look for an anonymous method body
        if (e.expr.startsWith('{')) {
            // don't parse it - just scan for the closing brace
            const brace_re = /\/\*[\d\D]*?\*\/|\/\/.*|".*?"|".*|'.'?|(\{)|(\})/g;
            let balance = 0, body_end = e.expr.length;
            for (let m; m = brace_re.exec(e.expr); ) {
                if (m[1]) balance++;
                else if (m[2] && (--balance === 0)) {
                    body_end = m.index + 1;
                    break;
                }
            }
            method_body = e.expr.slice(0, body_end);
            strip(e, method_body.length);
        }
    }
    return new NewObjectExpression(ctr_call, post_ctr_qualifiers, method_body);
}

/**
 * @param {ExpressionText} e 
 * @param {RootExpression} ctr 
 * @param {Number} first_array_qualifier_idx
 */
function parseNewArrayExpression(e, ctr, first_array_qualifier_idx) {
    let arrdim_initers = [];
    let i = first_array_qualifier_idx;
    for (; i < ctr.qualified_terms.length; i++) {
        const term = ctr.qualified_terms[i];
        if (term instanceof ArrayIndexExpression) {
            arrdim_initers.push(term);
            continue;
        }
        break;
    }
    const type = new RootExpression(ctr.root_term, ctr.root_term_type, ctr.qualified_terms.slice(0, first_array_qualifier_idx));
    return new NewArrayExpression(type, arrdim_initers, ctr.qualified_terms.slice(i));
}
    
/**
 * @param {ExpressionText} e 
 */
function parseNewExpression(e) {
    const ctr = parse_expression_term(e);
    if (!(ctr instanceof RootExpression)) {
        return null;
    }
    let new_expression = null;
    ctr.qualified_terms.find((qt,idx) => {
        if (qt instanceof MethodCallExpression) {
            // new object contructor - split into constructor qualifiers and post-ctr-qualifiers
            const qualified_terms = ctr.qualified_terms.slice();
            const ctr_qualifiers = qualified_terms.splice(0, idx + 1);
            new_expression = parseNewObjectExpression(e, ctr, ctr_qualifiers, qualified_terms);
            return true;
        }
        if (qt instanceof ArrayIndexExpression) {
            // new array constructor
            // in java, multi-dimensional array constructors have priority over array accessors
            // e.g new int[2][1] - is a 2D array, 
            //     (new int[2])[1] - is the 1th element of a 1D array
            new_expression = parseNewArrayExpression(e, ctr, idx);
            return true;
        }
    });
    if (!new_expression) {
        // treat unqualified new expressions as object constructors with no parameters
        // eg. new XYZ === new XYZ()
        new_expression = parseNewObjectExpression(e, ctr, ctr.qualified_terms, []);
    }
    return new_expression;
}

/**
 * @param {ExpressionText} e 
 */
function parseArrayLiteral(e) {
    const arr = new ArrayLiteralExpression();
    if (!strip(e, '}')) {
        for (let element; ;) {
            if ((element = parse_expression(e)) === null) {
                return null;
            }
            arr.elements.push(element);
            if (strip(e, ',')) continue;
            if (strip(e, '}')) break;
            return null;
        }
    }
    return arr;
}

/**
 * @param {ExpressionText} e 
 */
function parse_expression_term(e) {
    if (e.expr[0] === '(') {
        const subexpr = new ExpressionText(e.expr);
        const bexpr = parseBracketOrCastExpression(subexpr);
        e.expr = subexpr.expr;
        return bexpr;
    }
    const unop = e.expr.match(/^(?:(!\s?)+|(~\s?)+|(?:([+-]\s?)+(?![\d.])))/);
    if (unop) {
        return parseUnaryExpression(e, unop[0]);
    }
    const root_term_types = ['boolean', 'boolean', 'null', 'ident', 'hexint', 'octint', 'decfloat', 'decint', 'char', 'echar', 'uchar', 'string'];
    const root_term = e.expr.match(/^(?:(true(?![\w$]))|(false(?![\w$]))|(null(?![\w$]))|([a-zA-Z_$][a-zA-Z0-9_$]*)|([+-]?0x[0-9a-fA-F]+[lL]?)|([+-]?0[0-7]+[lL]?)|([+-]?\d+\.?\d*(?:[eE][+-]?\d+)?[fFdD]?)|([+-]?\d+(?:[eE]\+?\d+)?[lL]?)|('[^\\']')|('\\[bfrntv0]')|('\\u[0-9a-fA-F]{4}')|("[^"]*"))/);
    if (!root_term) {
        return null;
    }
    strip(e, root_term[0].length);
    const root_term_type = root_term_types[[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].find(x => root_term[x]) - 1];
    const qualified_terms = parse_qualified_terms(e);
    if (qualified_terms === null) {
        return null;
    }
    return new RootExpression(root_term[0], root_term_type, qualified_terms);
}

/**
 * @param {string} s 
 */
function getBinaryOperator(s) {
    const binary_op_match = s.match(/^([!=/%*&|^+-]=?|<<?=?|>>?[>=]?|&&|\|\||[/%*&|^]|\+(?=[^+]|[+][\w\d.])|\-(?=[^-]|[-][\w\d.])|instanceof\b|\?)/);
    return binary_op_match ? binary_op_match[0] : null;
}

/**
 * @param {ExpressionText|string} e 
 * @returns {ParsedExpression}
 */
function parse_expression(e) {
    if (typeof e === 'string') {
        e = new ExpressionText(e);
    }
    const newop = e.expr.match(/^new\b/);
    if (newop) {
        strip(e, 3);
        return parseNewExpression(e);
    }
    const arrayinit = e.expr.match(/^\{/);
    if (arrayinit) {
        strip(e, 1);
        return parseArrayLiteral(e);
    }
    const prefix_incdec = e.expr.match(/^(?:(\+\+)|\-\-)(?=[a-zA-Z_])/);
    if (prefix_incdec) {
        strip(e, 2);
    }
    let res = parse_expression_term(e);
    if (prefix_incdec) {
        res = new IncOpExpression(e.expr[1] ? '++e' : '--e', res);
    }

    const postfix_incdec = e.expr.match(/^(?:(\+\+)|\-\-)(?![+-])/);
    if (postfix_incdec) {
        if (prefix_incdec) {
            return null;
        }
        strip(e, 2);
        res = new IncOpExpression(e.expr[1] ? 'e++' : 'e--', res);
    }

    for (; ;) {
        const binary_operator = getBinaryOperator(e.expr);
        if (!binary_operator) {
            break;
        }
        const prec_diff = operator_precedences[binary_operator] - e.current_precedence;
        if (prec_diff > 0) {
            // bigger number -> lower precendence -> end of (sub)expression
            break;
        }
        if (prec_diff === 0 && binary_operator !== '?') {
            // equal precedence, ltr evaluation
            break;
        }
        // higher or equal precendence
        e.precedence_stack.unshift(e.current_precedence + prec_diff);
        strip(e, binary_operator.length);
        if (binary_operator === '?') {
            res = new TernaryExpression(res);
            res.ternary_true = parse_expression(e);
            if (!strip(e, ':')) {
                return null;
            }
            res.ternary_false = parse_expression(e);
        } else {
            res = new BinaryOpExpression(res, binary_operator, parse_expression(e));
        }
        e.precedence_stack.shift();
    }
    return res;
}

module.exports = {
    ArrayIndexExpression,
    BinaryOpExpression,
    ExpressionText,
    MemberExpression,
    MethodCallExpression,
    NewArrayExpression,
    NewObjectExpression,
    parse_expression,
    ParsedExpression,
    QualifierExpression,
    RootExpression,
    TypeCastExpression,
    UnaryOpExpression,
}
