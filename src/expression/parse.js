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
     * @param {string} cast_type 
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

class TernaryExpression extends ParsedExpression {
    constructor(condition) {
        super();
        this.condition = condition;
        this.ternary_true = null;
        this.ternary_false = null;
    }
}

class QualifierExpression extends ParsedExpression {

}

class ArrayIndexExpression extends QualifierExpression {
    constructor(e) {
        super();
        this.indexExpression = e;
    }
}

class MethodCallExpression extends QualifierExpression {
    arguments = [];
}

class MemberExpression extends QualifierExpression {
    constructor(name) {
        super();
        this.name = name;
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
    if (res instanceof RootExpression) {
        if (/^(int|long|byte|short|double|float|char|boolean)$/.test(res.root_term) && !res.qualified_terms.length) {
            // primitive typecast
            const castexpr = parse_expression_term(e);
            if (!castexpr) {
                return null;
            }
            res = new TypeCastExpression(res.root_term, castexpr);
        }
    }
    return res;
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
 */
function parse_expression_term(e) {
    if (e.expr[0] === '(') {
        return parseBracketOrCastExpression(new ExpressionText(e.expr));
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
    // the root term is not allowed to be a method call
    if (qualified_terms[0] instanceof MethodCallExpression) {
        return null;
    }
    return new RootExpression(root_term[0], root_term_type, qualified_terms);
}

/**
 * @param {string} s 
 */
function getBinaryOperator(s) {
    const binary_op_match = s.match(/^([/%*&|^+-]=|<<=|>>>?=|[><!=]=|<<|>>>?|[><]|&&|\|\||[/%*&|^]|\+(?=[^+]|[+][\w\d.])|\-(?=[^-]|[-][\w\d.])|instanceof\b|\?)/);
    return binary_op_match ? binary_op_match[0] : null;
}

/**
 * @param {ExpressionText} e 
 * @returns {ParsedExpression}
 */
function parse_expression(e) {
    let res = parse_expression_term(e);

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
    parse_expression,
    ParsedExpression,
    QualifierExpression,
    RootExpression,
    TypeCastExpression,
    UnaryOpExpression,
}
