/**
 * Method body parsing is entirely linear and relies upon type processing being completed so
 * we can resolve packages, types, fields, methods, parameters and locals along the way.
 * 
 * Each token also contains detailed state information used for completion suggestions.
 */
const { JavaType, CEIType, PrimitiveType, ArrayType, UnresolvedType, Field, Method, Parameter, Constructor, signatureToType } = require('java-mti');
const { SourceMethod, SourceConstructor } = require('./source-type');
const ResolvedImport = require('./parsetypes/resolved-import');
const ParseProblem = require('./parsetypes/parse-problem');
const { TextBlock, BlockRange } = require('./parsetypes/textblock');

/**
 * @typedef {SourceMethod|SourceConstructor} SourceMC
 */

/**
 * @param {string} source 
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function parseBody(source, method, imports, typemap) {
    const body = method._decl.body().blockArray();
    if (!body || !body.simplified.startsWith('{')) {
        return null;
    }

    const tokens = tokenize(source, body.start, body.length);
    const tokenlist = new TokenList(tokens);
    let block = null;
    try {
        statementBlock(tokenlist, [], method, imports, typemap);
    } catch (err) {
        addproblem(tokenlist, ParseProblem.Information(tokenlist.current, `Parse failed: ${err.message}`));

    }
    return {
        block,
        tokens,
        problems: tokenlist.problems,
    }
}

/**
 * 
 * @param {TokenList} tokens 
 * @param {ParseProblem} problem 
 */
function addproblem(tokens, problem) {
    tokens.problems.push(problem);
}

/**
 * @param {Local[]} locals 
 * @param {Local[]} new_locals 
 */
function addLocals(tokens, locals, new_locals) {
    for (let local of new_locals) {
        if (locals.find(l => l.name === local.name)) {
            addproblem(tokens, ParseProblem.Error(local.decltoken, `Redeclared variable: ${local.name}`));
        }
        locals.unshift(local);
    }
}

class TokenList {
    constructor(tokens) {
        this.tokens = tokens;
        this.idx = -1;
        /** @type {Token} */
        this.current = null;
        this.inc();
        /** @type {ParseProblem[]} */
        this.problems = [];
    }

    inc() {
        for (;;) {
            this.current = this.tokens[this.idx += 1];
            if (!this.current || this.current.kind !== 'wsc') {
                return this.current;
            }
        }
    }

    /**
     * Check if the current token matches the specified value and consumes it
     * @param {string} value 
     */
    isValue(value) {
        if (this.current.value === value) {
            this.inc();
            return true;
        }
        return false;
    }

    /**
     * Check if the current token matches the specified value and consumes it or reports an error
     * @param {string} value 
     */
    expectValue(value) {
        if (this.isValue(value)) {
            return true;
        }
        addproblem(this, ParseProblem.Error(this.current, `${value} expected`));
        return false;
    }

    get previous() {
        for (let idx = this.idx-1; idx >= 0 ; idx--) {
            if (idx === 0 || this.tokens[idx].kind !== 'wsc') {
                return this.tokens[idx];
            }
        }
    }
}

/**
 * @param {TokenList} tokens 
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {ResolvedIdent|Local[]|Statement}
 */
function statement(tokens, locals, method, imports, typemap) {
    let s;
    switch(tokens.current.kind) {
        case 'statement-kw':
            s = statementKeyword(tokens, locals, method, imports, typemap);
            return s;
        case 'modifier':
        case 'ident':
        case 'primitive-type':
            s = expression_or_var_decl(tokens, locals, method, imports, typemap);
            if (Array.isArray(s)) {
                addLocals(tokens, locals, s);
            }
            semicolon(tokens);
            return s;
        case 'string-literal':
        case 'char-literal':
        case 'number-literal':
        case 'boolean-literal':
        case 'object-literal':
        case 'inc-operator':
        case 'plumin-operator':
        case 'unary-operator':
        case 'open-bracket':
        case 'new-operator':
            s = expression(tokens, locals, method, imports, typemap);
            semicolon(tokens);
            return s;
    }
    switch(tokens.current.value) {
        case ';':
            tokens.inc();
            return new EmptyStatement();
        case '{':
            return statementBlock(tokens, locals, method, imports, typemap);
    }
    addproblem(tokens, ParseProblem.Error(tokens.current, `Statement expected`));
    tokens.inc();
    return new InvalidStatement();
}

class Statement {}
class EmptyStatement extends Statement {}
class SwitchStatement extends Statement {
    /** @type {ResolvedIdent} */
    test = null;
    cases = [];
    caseBlocks = [];
}
class Block extends Statement {
    statements = [];
}
class TryStatement extends Statement {
    block = null;
    catches = [];
}
class IfStatement extends Statement {
    test = null;
    statement = null;
    elseStatement = null;
}
class WhileStatement extends Statement {
    test = null;
    statement = null;
}
class BreakStatement extends Statement {}
class ContinueStatement extends Statement {}
class DoStatement extends Statement {
    test = null;
    block = null;
}
class ReturnStatement extends Statement {
    expression = null;
}
class ThrowStatement extends Statement {
    expression = null;
}
class InvalidStatement extends Statement {}
class ForStatement extends Statement {
    /** @type {ResolvedIdent[] | Local[]} */
    init = null;
    /** @type {ResolvedIdent} */
    test = null;
    /** @type {ResolvedIdent[]} */
    update = null;
    /** @type {ResolvedIdent} */
    iterable = null;
    /** @type {Statement} */
    statement = null;
}

/**
 * @param {TokenList} tokens 
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function statementBlock(tokens, locals, method, imports, typemap) {
    const b = new Block();
    tokens.expectValue('{');
    const block_locals = locals.slice();
    while (!tokens.isValue('}')) {
        const s = statement(tokens, block_locals, method, imports, typemap);
        if (s instanceof EmptyStatement) {
            addproblem(tokens, ParseProblem.Hint(tokens.previous, `Redundant semicolon`));
        }
        b.statements.push(s);
    }
    return b;
}

/**
 * @param {TokenList} tokens
 */
function semicolon(tokens) {
    if (tokens.isValue(';')) {
        return;
    }
    addproblem(tokens, ParseProblem.Error(tokens.previous, 'Missing operator or semicolon'));
}

/**
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function statementKeyword(tokens, locals, method, imports, typemap) {
    let s;
    switch (tokens.current.value) {
        case 'if':
            tokens.inc();
            s = new IfStatement();
            s.test = bracketedTest(tokens, locals, method, imports, typemap);
            s.statement = nonVarDeclStatement(tokens, locals, method, imports, typemap);
            if (tokens.isValue('else')) {
                s.elseStatement = nonVarDeclStatement(tokens, locals, method, imports, typemap);
            }
            break;
        case 'while':
            tokens.inc();
            s = new WhileStatement();
            s.test = bracketedTest(tokens, locals, method, imports, typemap);
            s.statement = nonVarDeclStatement(tokens, locals, method, imports, typemap);
            break;
        case 'break':
            tokens.inc();
            s = new BreakStatement();
            semicolon(tokens);
            break;
        case 'continue':
            tokens.inc();
            s = new ContinueStatement();
            semicolon(tokens);
            break;
        case 'switch':
            tokens.inc();
            s = new SwitchStatement();
            switchBlock(s, tokens, locals, method, imports, typemap);
            break;
        case 'do':
            tokens.inc();
            s = new DoStatement();
            s.block = statementBlock(tokens, locals, method, imports, typemap);
            tokens.expectValue('while');
            s.test = bracketedTest(tokens, locals, method, imports, typemap);
            semicolon(tokens);
            break;
        case 'try':
            tokens.inc();
            s = new TryStatement();
            s.block = statementBlock(tokens, locals, method, imports, typemap);
            catchFinallyBlocks(s, tokens, locals, method, imports, typemap);
            break;
        case 'return':
            tokens.inc();
            s = new ReturnStatement();
            s.expression = isExpressionStart(tokens.current) ? expression(tokens, locals, method, imports, typemap) : null;
            if (method instanceof SourceMethod)
                checkReturnExpression(tokens, method, s.expression);
            else if (method instanceof SourceConstructor) {
                if (s.expression) {
                    addproblem(tokens, ParseProblem.Error(tokens.current, `Constructors are not allowed to return values`));
                }
            }
            semicolon(tokens);
            break;
        case 'throw':
            tokens.inc();
            s = new ThrowStatement();
            if (!tokens.isValue(';')) {
                s.expression = isExpressionStart(tokens.current) ? expression(tokens, locals, method, imports, typemap) : null;
                checkThrowExpression(tokens, s.expression, typemap);
                semicolon(tokens);
            }
            break;
        case 'for':
            tokens.inc();
            s = new ForStatement();
            forStatement(s, tokens, locals.slice(), method, imports, typemap);
            break;
        default:
            s = new InvalidStatement();
            addproblem(tokens, ParseProblem.Error(tokens.current, `Unexpected token: ${tokens.current.value}`));
            tokens.inc();
            break;
    }
    return s;
}

/**
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function bracketedTest(tokens, locals, method, imports, typemap) {
    tokens.expectValue('(');
    const e = expression(tokens, locals, method, imports, typemap);
    if (e.variables[0] && e.variables[0].type.typeSignature !== 'Z') {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Type of expression must be boolean`));
    }
    tokens.expectValue(')');
    return e;
}

/**
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function nonVarDeclStatement(tokens, locals, method, imports, typemap) {
    const s = statement(tokens, locals, method, imports, typemap);
    if (Array.isArray(s)) {
        addproblem(tokens, ParseProblem.Error(tokens.previous, `Variable declarations are not permitted as a single conditional statement.`));
    }
    return s;
}

/**
* @param {ForStatement} s
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function forStatement(s, tokens, locals, method, imports, typemap) {
    tokens.expectValue('(');
    if (!tokens.isValue(';')) {
        s.init = expression_list_or_var_decl(tokens, locals, method, imports, typemap);
        // s.init is always an array, so we need to check the element type
        if (s.init[0] instanceof Local) {
            // @ts-ignore
            addLocals(tokens, locals, s.init);
        }
        if (tokens.current.value === ':') {
            enhancedFor(s, tokens, locals, method, imports, typemap);
            return;
        }
        semicolon(tokens);
    }
    // for-condition
    if (!tokens.isValue(';')) {
        s.test = expression(tokens, locals, method, imports, typemap);
        semicolon(tokens);
    }
    // for-updated
    if (!tokens.isValue(')')) {
        s.update = expressionList(tokens, locals, method, imports, typemap);
        tokens.expectValue(')');
    }
    s.statement = nonVarDeclStatement(tokens, locals, method, imports, typemap);
}

/**
* @param {ForStatement} s
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function enhancedFor(s, tokens, locals, method, imports, typemap) {
    const colon = tokens.current;
    tokens.inc();
    // enhanced for
    const iter_var = s.init[0];
    if (!(iter_var instanceof Local)) {
        addproblem(tokens, ParseProblem.Error(tokens.previous, `For iterator must be a single variable declaration`));
    }
    s.iterable = expression(tokens, locals, method, imports, typemap);
    const value = s.iterable.variables[0];
    if (!value) {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Expression expected`));
    }
    if (iter_var instanceof Local) {
        let is_iterable = false, is_assignable = false;
        if (value && value.type instanceof ArrayType) {
            is_iterable = true; // all arrays are iterable
            is_assignable = isTypeAssignable(iter_var.type, value.type.elementType);
        } else if (value.type instanceof CEIType) {
            const iterables = getTypeInheritanceList(value.type).filter(t => t.rawTypeSignature === 'Ljava/lang/Iterable;');
            is_iterable = iterables.length > 0;
            is_assignable = true;   // todo - check the specialised versions of iterable to match the type against iter_var
        }
        if (!is_iterable) {
            addproblem(tokens, ParseProblem.Error(tokens.current, `Type '${value.type.fullyDottedTypeName}' is not an array or a java.lang.Iterable type`));
        }
        else if (!is_assignable) {
            addproblem(tokens, ParseProblem.Error(tokens.current, `Variable of type '${iter_var.type.fullyDottedTypeName}' is not compatible with iterable expression of type '${value.type.fullyDottedTypeName}'`));
        }
    }
    tokens.expectValue(')');
    s.statement = nonVarDeclStatement(tokens, locals, method, imports, typemap);
}

/**
* @param {TryStatement} s
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function catchFinallyBlocks(s, tokens, locals, method, imports, typemap) {
    for (;;) {
        if (tokens.isValue('finally')) {
            if (s.catches.find(c => c instanceof Block)) {
                addproblem(tokens, ParseProblem.Error(tokens.current, `Multiple finally blocks are not permitted`));
            }
            s.catches.push(statementBlock(tokens, locals, method, imports, typemap));
            continue;
        }
        if (tokens.isValue('catch')) {
            const catchinfo = {
                types: [],
                name: null,
                block: null,
            }
            tokens.expectValue('(');
            const mods = [];
            while (tokens.current.kind === 'modifier') {
                mods.push(tokens.current);
                tokens.inc();
            }
            let t = catchType(tokens, locals, method, imports, typemap);
            if (t) catchinfo.types.push(t);
            while (tokens.isValue('|')) {
                let t = catchType(tokens, locals, method, imports, typemap);
                if (t) catchinfo.types.push(t);
            }
            if (tokens.current.kind === 'ident') {
                catchinfo.name = tokens.current;
                tokens.inc();
            } else {
                addproblem(tokens, ParseProblem.Error(tokens.current, `Variable identifier expected`));
            }
            tokens.expectValue(')');
            let exceptionVar;
            if (catchinfo.types[0] && catchinfo.name) {
                checkLocalModifiers(tokens, mods);
                exceptionVar = new Local(mods, catchinfo.name.value, catchinfo.name, catchinfo.types[0]);
            }
            catchinfo.block = statementBlock(tokens, [...locals, exceptionVar], method, imports, typemap);
            s.catches.push(catchinfo);
            continue;
        }
        if (!s.catches.length) {
            addproblem(tokens, ParseProblem.Error(tokens.current, `Missing catch or finally block`));
        }
        const first_finally_idx = s.catches.findIndex(c => c instanceof Block);
        if (first_finally_idx >= 0) {
            if (s.catches.slice(first_finally_idx).find(c => !(c instanceof Block))) {
                addproblem(tokens, ParseProblem.Error(tokens.current, `Catch blocks must be declared before a finally block`));
            }
        }
        return;
    }
}

/**
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function catchType(tokens, locals, method, imports, typemap) {
    const t = qualifiedTerm(tokens, locals, method, imports, typemap);
    if (t.types[0]) {
        return t.types[0];
    }
    addproblem(tokens, ParseProblem.Error(tokens.current, `Missing or invalid type`));
    return new UnresolvedType(t.source);
}
    
/**
* @param {SwitchStatement} s
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function switchBlock(s, tokens, locals, method, imports, typemap) {
    tokens.expectValue('(');
    s.test = expression(tokens, locals, method, imports, typemap);
    let test_type = null;
    if (s.test.variables[0]) {
        // test must be int-compatible or be a string
        test_type = s.test.variables[0].type;
        if (!/^(Ljava\/lang\/String;|[BSIC])$/.test(test_type.typeSignature)) {
            test_type = null;
            addproblem(tokens, ParseProblem.Error(tokens.current, `Expression of type '${s.test.variables[0].type.fullyDottedTypeName}' is not compatible with int or java.lang.String`));
        }
    }
    tokens.expectValue(')');
    tokens.expectValue('{');
    while (!tokens.isValue('}')) {
        if (/^(case|default)$/.test(tokens.current.value)) {
            caseBlock(s, test_type, tokens, locals, method, imports, typemap);
            continue;
        }
        addproblem(tokens, ParseProblem.Error(tokens.current, 'case statement expected'));
        break;
    }
    return s;
}

/**
* @param {SwitchStatement} s
* @param {JavaType} test_type
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function caseBlock(s, test_type, tokens, locals, method, imports, typemap) {
    const case_start_idx = s.cases.length;
    caseExpressionList(s.cases, test_type, tokens, locals, method, imports, typemap);
    const statements = [];
    for (;;) {
        if (/^(case|default|\})$/.test(tokens.current.value)) {
            break;
        }
        const s = statement(tokens, locals, method, imports, typemap);
        statements.push(s);
    }
    s.caseBlocks.push({
        cases: s.cases.slice(case_start_idx),
        statements,
    });
}

/**
* @param {(ResolvedIdent|boolean)[]} cases
* @param {JavaType} test_type
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function caseExpressionList(cases, test_type, tokens, locals, method, imports, typemap) {
    let c = caseExpression(cases, test_type, tokens, locals, method, imports, typemap);
    if (!c) {
        return;
    }
    while (c) {
        cases.push(c);
        c = caseExpression(cases, test_type, tokens, locals, method, imports, typemap);
    }
}

/**
* @param {(ResolvedIdent|boolean)[]} cases
* @param {JavaType} test_type
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function caseExpression(cases, test_type, tokens, locals, method, imports, typemap) {
    /** @type {boolean|ResolvedIdent} */
    let e = tokens.isValue('default');
    if (e && cases.find(c => c === e)) {
        addproblem(tokens, ParseProblem.Error(tokens.previous, `Duplicate case: default`))
    }
    if (!e) {
        if (tokens.isValue('case')) {
            e = expression(tokens, locals, method, imports, typemap);
            if (e.variables[0]) {
                if (test_type && !isTypeAssignable(e.variables[0].type, test_type)) {
                    addproblem(tokens, ParseProblem.Error(tokens.current, `Incompatible types: Expression of type '${e.variables[0].type.fullyDottedTypeName}' is not comparable to an expression of type '${test_type.fullyDottedTypeName}'`));
                }
                if (!isConstantValue(e.variables[0])) {
                    addproblem(tokens, ParseProblem.Error(tokens.current, `Constant expression required`));
                }
            }
            // todo - check duplicate non-default cases
        }
    }
    if (e) {
        tokens.expectValue(':');
    }
    return e;
}

/**
 * @param {Local | Parameter | Field | ArrayElement | Value} v 
 */
function isConstantValue(v) {
    if (v instanceof Local) {
        return !!v.finalToken;
    }
    if (v instanceof Field) {
        return v.modifiers.includes('final');
    }
    // Parameters and ArrayElements are never constant
    return v instanceof LiteralValue;
}

/**
 * @param {TokenList} tokens 
 * @param {Method} method 
 * @param {ResolvedIdent} return_expression 
 */
function checkReturnExpression(tokens, method, return_expression) {
    if (!return_expression && method.returnType.typeSignature === 'V') {
        return;
    }
    if (return_expression && method.returnType.typeSignature === 'V') {
        addproblem(tokens, ParseProblem.Error(tokens.current, `void methods cannot return values`));
        return;
    }
    if (!return_expression && method.returnType.typeSignature !== 'V') {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Method must return a value of type '${method.returnType.fullyDottedTypeName}'`));
        return;
    }
    if (!return_expression.variables[0]) {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Method must return a value of type '${method.returnType.fullyDottedTypeName}'`));
        return;
    }
    const expr_type = return_expression.variables[0].type;
    const is_assignable = isTypeAssignable(method.returnType, expr_type);
    if (!is_assignable) {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Incompatible types: Expression of type '${expr_type.fullyDottedTypeName}' cannot be returned from a method of type '${method.returnType.fullyDottedTypeName}'`));
    }
}

/**
 * @param {TokenList} tokens 
 * @param {ResolvedIdent} throw_expression 
 * @param {Map<string,JavaType>} typemap 
 */
function checkThrowExpression(tokens, throw_expression, typemap) {
    if (!throw_expression.variables[0]) {
        return;
    }
    let is_throwable = isTypeAssignable(typemap.get('java/lang/Throwable'), throw_expression.variables[0].type);
    if (!is_throwable) {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Incompatible types: throw expression must inherit from java.lang.Throwable`));
    }
}

/**
 * @param {TokenList} tokens 
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {ResolvedIdent|Local[]}
 */
function expression_or_var_decl(tokens, locals, method, imports, typemap) {
    const mods = [];
    while (tokens.current.kind === 'modifier') {
        mods.push(tokens.current);
        tokens.inc();
    }

    /** @type {ResolvedIdent} */
    let matches = expression(tokens, locals, method, imports, typemap);

    // if theres at least one type followed by an ident, we assume a variable declaration
    if (matches.types[0] && tokens.current.kind === 'ident') {
        const new_locals = [];
        checkLocalModifiers(tokens, mods);
        for (;;) {
            let local = new Local(mods, tokens.current.value, tokens.current, matches.types[0]);
            tokens.inc();
            if (tokens.isValue('=')) {
                const op = tokens.previous;
                local.init = expression(tokens, locals, method, imports, typemap);
                if (local.init.variables[0])
                    checkAssignmentExpression(tokens, local, op, local.init.variables[0]);
            }
            new_locals.push(local);
            if (tokens.isValue(',')) {
                if (tokens.current.kind === 'ident') {
                    continue;
                }
                addproblem(tokens, ParseProblem.Error(tokens.current, `Variable name expected`));
            }
            break;
        }
        return new_locals;
    }

    if (mods.length) {
        addproblem(tokens, ParseProblem.Error(mods[0], `Unexpected token: '${mods[0].value}'`))
    }
    return matches;
}

/**
 * @param {TokenList} tokens 
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {ResolvedIdent[]|Local[]}
 */
function expression_list_or_var_decl(tokens, locals, method, imports, typemap) {
    let e = expression_or_var_decl(tokens, locals, method, imports, typemap);
    if (Array.isArray(e)) {
        // local var decl
        return e;
    }
    const expressions = [e];
    while (tokens.isValue(',')) {
        e = expression(tokens, locals, method, imports, typemap);
        expressions.push(e);
    }
    return expressions;
}


/**
 * @param {Token[]} mods 
 */
function checkLocalModifiers(tokens, mods) {
    for (let i=0; i < mods.length; i++) {
        if (mods[i].value !== 'final') {
            addproblem(tokens, ParseProblem.Error(mods[i], `Modifier '${mods[i].source}' cannot be applied to local variable declarations.`));
        } else if (mods.findIndex(m => m.source === 'final') < i) {
            addproblem(tokens, ParseProblem.Error(mods[i], `Repeated 'final' modifier.`));
        }
    }
}

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
    '+=':12,'-=':12,'*=':12,'/=':12,'%=':12,
    '<<=':12,'>>=':12, '&=':12, '|=':12, '^=':12,
    '&&=':12, '||=':12,
}

/**
 * @param {TokenList} tokens 
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function expression(tokens, locals, method, imports, typemap, precedence_stack = [13]) {
    /** @type {ResolvedIdent} */
    let matches = qualifiedTerm(tokens, locals, method, imports, typemap);

    for(;;) {
        if (!/^(assignment|equality|comparison|bitwise|logical|muldiv|plumin|instanceof)-operator/.test(tokens.current.kind) && !/\?/.test(tokens.current.value)) {
            break;
        }
        const binary_operator = tokens.current;
        const operator_precedence = operator_precedences[binary_operator.source];
        if (operator_precedence > precedence_stack[0]) {
            // bigger number -> lower precendence -> end of (sub)expression
            break;
        }
        if (operator_precedence === precedence_stack[0] && binary_operator.source !== '?' && binary_operator.kind !== 'assignment-operator') {
            // equal precedence, ltr evaluation
            break;
        }
        tokens.inc();
        // higher or equal precendence with rtl evaluation
        const rhs = expression(tokens, locals, method, imports, typemap, [operator_precedence, ...precedence_stack]);

        if (binary_operator.value === '?') {
            const colon = tokens.current;
            tokens.expectValue(':');
            const falseStatement = expression(tokens, locals, method, imports, typemap, [operator_precedence, ...precedence_stack]);
            matches = resolveTernaryExpression(tokens, matches, colon, rhs, falseStatement);
        } else {
            matches = resolveBinaryOpExpression(tokens, matches, binary_operator, rhs);
        }
    }

    return matches;
}

/**
 * @param {TokenList} tokens
 * @param {ResolvedIdent} test 
 * @param {Token} colon 
 * @param {ResolvedIdent} truthy 
 * @param {ResolvedIdent} falsey 
 */
function resolveTernaryExpression(tokens, test, colon, truthy, falsey) {
    const ident = `${test.source} ? ${truthy.source} : ${falsey.source}`;
    if (!truthy.variables[0] || !falsey.variables[0]) {
        return new ResolvedIdent(ident);
    }
    return new ResolvedIdent(ident, [new TernaryValue(ident, truthy.variables[0].type, colon, falsey.variables[0])]);
}
    
/**
 * @param {TokenList} tokens
 * @param {ResolvedIdent} lhs 
 * @param {Token} op 
 * @param {ResolvedIdent} rhs 
 */
function resolveBinaryOpExpression(tokens, lhs, op, rhs) {
    const ident = `${lhs.source} ${op.value} ${rhs.source}`
    switch(op.kind) {
        case 'assignment-operator':
            return resolveAssignment(tokens, ident, lhs, op, rhs);
        case 'equality-operator':
            return resolveEquality(tokens, ident, lhs, op, rhs);
        case 'comparison-operator':
            return resolveComparison(tokens, ident, lhs, op, rhs);
        case 'bitwise-operator':
            return resolveBitwise(tokens, ident, lhs, op, rhs);
        case 'logical-operator':
            return resolveLogical(tokens, ident, lhs, op, rhs);
        case 'instanceof-operator':
            return resolveInstanceOf(tokens, ident, lhs, op, rhs);
        case 'plumin-operator':
        case 'muldiv-operator':
            return resolveMath(tokens, ident, lhs, op, rhs);
    }
    throw new Error(`Unhandled binary operator: ${op.kind}`)
}

/**
 * @param {TokenList} tokens 
 * @param {string} ident 
 * @param {ResolvedIdent} lhs 
 * @param {Token} op 
 * @param {ResolvedIdent} rhs 
 */
function resolveAssignment(tokens, ident, lhs, op, rhs) {
    if (!lhs.variables[0] || !rhs.variables[0]) {
        addproblem(tokens, ParseProblem.Error(op, `Invalid expression: ${ident}`));
        return new ResolvedIdent(ident);
    }
    const lhsvar = lhs.variables[0];
    let rhsvar = rhs.variables[0];
    const pre_assign_operator = op.value.slice(0, -1);
    if (pre_assign_operator) {
        switch (getOperatorType(pre_assign_operator)) {
            case "bitwise-operator":
                // ^ is classed as a bitwise operator, but is also a logical operator
                checkOperator(tokens, lhsvar, op, rhsvar, pre_assign_operator === '^' ? /^[BSIJCZ]{2}$/ : /^[BSIJC]{2}$/);
                rhsvar = new Value(rhs.source, lhsvar.type);
                break;
            case "logical-operator":
                checkOperator(tokens, lhsvar, op, rhsvar, /^ZZ$/);
                break;
            case "muldiv-operator":
                checkOperator(tokens, lhsvar, op, rhsvar, /^([BSIJC]{2}|[FD][BSIJCFD])$/);
                rhsvar = new Value(rhs.source, lhsvar.type);
                break;
            case "plumin-operator":
                if (pre_assign_operator === '+' && lhsvar.type.typeSignature === 'Ljava/lang/String;') {
                    // implicitly cast the rhs to a String value
                    rhsvar = new Value(rhs.source, lhsvar.type);
                } else {
                    checkOperator(tokens, lhsvar, op, rhsvar, /^([BSIJC]{2}|[FD][BSIJCFD])$/);
                    rhsvar = new Value(rhs.source, lhsvar.type);
                }
                break;
        }
    }
    checkAssignmentExpression(tokens, lhsvar, op, rhsvar);
    // the result type is always the lhs
    // e.g float = double = int will fail because of failure to convert from double to float
    return new ResolvedIdent(lhsvar.name, [new Value(lhsvar.name, lhsvar.type)]);
}

/**
 * @param {TokenList} tokens 
 * @param {Local|Parameter|Field|ArrayElement|Value} variable 
 * @param {Token} op
 * @param {Local|Parameter|Field|ArrayElement|Value} value 
 */
function checkAssignmentExpression(tokens, variable, op, value) {
    if (variable instanceof AnyValue || value instanceof AnyValue) {
        return true;
    }
    if (variable instanceof Value) {
        addproblem(tokens, ParseProblem.Error(op, `Invalid assignment: left-hand side is not a variable`));
        return;
    }
    let is_assignable;
    // we need to special-case ArrayLiteral because it has no type associated with it
    if (value instanceof ArrayLiteral) {
        is_assignable = isArrayAssignable(variable.type, value);
        if (!is_assignable) {
            addproblem(tokens, ParseProblem.Error(op, `Array literal expression is not compatible with variable of type '${variable.type.fullyDottedTypeName}'`));
        }
        return;
    }

    is_assignable = isTypeAssignable(variable.type, value.type);
    if (!is_assignable) {
        addproblem(tokens, ParseProblem.Error(op, `Incompatible types: Expression of type '${value.type.fullyDottedTypeName}' cannot be assigned to a variable of type '${variable.type.fullyDottedTypeName}'`));
    }

    if (value instanceof TernaryValue) {
        checkAssignmentExpression(tokens, variable, value.colon, value.falseValue);
    }
}

/**
 * @param {JavaType} variable_type 
 * @param {ArrayLiteral} value 
 */
function isArrayAssignable(variable_type, value) {
    if (!(variable_type instanceof ArrayType)) {
        return false;
    }
    // empty array literals are compatible with all arrays
    if (value.elements.length === 0) {
        return true;
    }
    const required_element_type = variable_type.arrdims > 1 ? new ArrayType(variable_type.base, variable_type.arrdims - 1) : variable_type.base;
    for (let i=0; i < value.elements.length; i++) {
        const element = value.elements[i];
        let is_assignable;
        if (required_element_type instanceof ArrayType) {
            // the element must be another array literal expression or a value with a matching array type
            if (element instanceof ArrayLiteral) {
                is_assignable = isArrayAssignable(required_element_type, element);
            } else {
                is_assignable = element.variables[0] ? isTypeAssignable(required_element_type, element.variables[0].type) : false;
            }
        } else {
            // base type = the element must match the (non-array) type
            if (element instanceof ArrayLiteral) {
                is_assignable = false;
            } else {
                is_assignable = element.variables[0] ? isTypeAssignable(required_element_type, element.variables[0].type) : false;
            }
        }
        if (!is_assignable) {
            return false;
        }
    }
    return true;
}

/**
 * @param {JavaType} source_type 
 * @param {JavaType} cast_type 
 */
function isTypeCastable(source_type, cast_type) {
    if (source_type.typeSignature === 'Ljava/lang/Object;') {
        // everything is castable from Object
        return true;
    }
    if (cast_type.typeSignature === 'Ljava/lang/Object;') {
        // everything is castable to Object
        return true;
    }
    if (source_type instanceof CEIType && cast_type instanceof CEIType) {
        // for class casts, one type must be in the inheritence tree of the other
        if (getTypeInheritanceList(source_type).includes(cast_type)) {
            return true;
        }
        if (getTypeInheritanceList(cast_type).includes(source_type)) {
            return true;
        }
        return false;
    }
    if (cast_type instanceof PrimitiveType) {
        // source type must be a compatible primitive or class
        switch (cast_type.typeSignature) {
            case 'B':
            case 'S':
            case 'I':
            case 'J': return /^([BSIJCFD]|Ljava\/lang\/(Byte|Short|Integer|Long|Character);)$/.test(source_type.typeSignature);
            case 'F':
            case 'D': return /^([BSIJCFD]|Ljava\/lang\/(Byte|Short|Integer|Long|Character|Float|Double);)$/.test(source_type.typeSignature);
            case 'Z': return /^([Z]|Ljava\/lang\/(Boolean);)$/.test(source_type.typeSignature);
        }
        return false;
    }
    if (cast_type instanceof ArrayType) {
        // the source type must have the same array dimensionality and have a castable base type
        if (source_type instanceof ArrayType) {
            if (source_type.arrdims === cast_type.arrdims) {
                if (isTypeCastable(source_type.base, cast_type.base)) {
                    return true;
                }
            }
        }
    }

    if (source_type instanceof AnyType || cast_type instanceof AnyType) {
        return true;
    }

    return false;
}

/**
 * Set of regexes to map source primitives to their destination types.
 * eg, long (J) is type-assignable to long, float and double (and their boxed counterparts)
 * Note that void (V) is never type-assignable to anything
 */
const valid_primitive_dest_types = {
    I: /^[IJFD]$|^Ljava\/lang\/(Integer|Long|Float|Double);$/,
    J: /^[JFD]$|^Ljava\/lang\/(Long|Float|Double);$/,
    S: /^[SIJFD]$|^Ljava\/lang\/(Short|Integer|Long|Float|Double);$/,
    B: /^[BSIJFD]$|^Ljava\/lang\/(Byte|Short|Integer|Long|Float|Double);$/,
    F: /^[FD]$|^Ljava\/lang\/(Float|Double);$/,
    D: /^D$|^Ljava\/lang\/(Double);$/,
    C: /^C$|^Ljava\/lang\/(Character);$/,
    Z: /^Z$|^Ljava\/lang\/(Boolean);$/,
    V: /$^/,    // V.test() always returns false
}

/**
 * Returns true if a value of value_type is assignable to a variable of dest_type
 * @param {JavaType} dest_type 
 * @param {JavaType} value_type 
 */
function isTypeAssignable(dest_type, value_type) {
    let is_assignable = false;
    if (dest_type.typeSignature === value_type.typeSignature) {
        // exact signature match
        is_assignable = true;
    } else if (dest_type instanceof AnyType || value_type instanceof AnyType) {
        // everything is assignable to or from AnyType
        is_assignable = true;
    } else if (dest_type.rawTypeSignature === 'Ljava/lang/Object;') {
        // everything is assignable to Object
        is_assignable = true;
    } else if (value_type instanceof PrimitiveType) {
        // primitives can only be assinged to other widening primitives or their class equivilents
        is_assignable = valid_primitive_dest_types[value_type.typeSignature].test(dest_type.typeSignature);
    } else if (value_type instanceof NullType) {
        // null is assignable to any non-primitive
        is_assignable = !(dest_type instanceof PrimitiveType);
    } else if (value_type instanceof ArrayType) {
        // arrays are assignable to other arrays with the same dimensionality and type-assignable bases
        is_assignable = dest_type instanceof ArrayType 
                && dest_type.arrdims === value_type.arrdims
                &&  isTypeAssignable(dest_type.base, value_type.base);
    } else if (value_type instanceof CEIType && dest_type instanceof CEIType) {
        // class/interfaces types are assignable to any class/interface types in their inheritence tree
        const valid_types = getTypeInheritanceList(value_type);
        is_assignable = valid_types.includes(dest_type);
        if (!is_assignable) {
            // generic types are also assignable to their raw counterparts
            const valid_raw_types = valid_types.map(t => t.getRawType());
            is_assignable = valid_raw_types.includes(dest_type);
        }
    }
    return is_assignable;
}

/**
 * @param {string} ident 
 * @param {ResolvedIdent} lhs 
 * @param {Token} op 
 * @param {ResolvedIdent} rhs 
 */
function resolveEquality(tokens, ident, lhs, op, rhs) {
    if (lhs.variables[0] && rhs.variables[0]) {
        checkEqualityComparison(tokens, lhs.variables[0], op, rhs.variables[0]);
    }
    return new ResolvedIdent(ident, [Value.build(ident, lhs, rhs, PrimitiveType.map.Z)]);
}

/**
 * @param {TokenList} tokens
 * @param {Local|Parameter|Field|ArrayElement|Value} lhs 
 * @param {Token} op
 * @param {Local|Parameter|Field|ArrayElement|Value} rhs 
 */
function checkEqualityComparison(tokens, lhs, op, rhs) {
    let is_comparable;
    if (lhs.type.typeSignature === rhs.type.typeSignature) {
        is_comparable = true;
    } else if (lhs.type instanceof AnyType || rhs.type instanceof AnyType) {
        is_comparable = true;
    } else if (lhs.type instanceof PrimitiveType) {
        const valid_rhs_type = {
            Z: /^Z$/,
            V: /^$/,
        }[lhs.type.typeSignature] || /^[BSIJFDC]$/;
        is_comparable = valid_rhs_type.test(rhs.type.typeSignature);
    } else if (lhs.type instanceof NullType || rhs.type instanceof NullType) {
        is_comparable = !(rhs.type instanceof PrimitiveType);
    } else if (lhs.type instanceof ArrayType) {
        const base_type = lhs.type.base;
        const valid_array_types = base_type instanceof CEIType ? getTypeInheritanceList(base_type) : [base_type];
        is_comparable = rhs.type.typeSignature === 'Ljava/lang/Object;'
          || (rhs.type instanceof ArrayType 
                && rhs.type.arrdims === rhs.type.arrdims
                && valid_array_types.includes(rhs.type));
    } else if (lhs.type instanceof CEIType && rhs.type instanceof CEIType) {
        const lhs_types = getTypeInheritanceList(lhs.type);
        const rhs_types = getTypeInheritanceList(rhs.type);
        is_comparable = lhs_types.includes(rhs.type) || rhs_types.includes(lhs.type);
    }
    if (!is_comparable) {
        addproblem(tokens, ParseProblem.Error(op, `Incomparable types: '${lhs.type.fullyDottedTypeName}' and '${rhs.type.fullyDottedTypeName}'`));
    }
    // warn about comparing strings
    if (lhs.type.typeSignature === 'Ljava/lang/String;' && rhs.type.typeSignature === 'Ljava/lang/String;') {
        addproblem(tokens, ParseProblem.Warning(op, `String comparisons using '==' or '!=' do not produce consistent results. Consider using 'String.equals(String other)' instead.`));
    }
}

/**
 * @param {TokenList} tokens
 * @param {string} ident 
 * @param {ResolvedIdent} lhs 
 * @param {Token} op 
 * @param {ResolvedIdent} rhs 
 */
function resolveComparison(tokens, ident, lhs, op, rhs) {
    if (lhs.variables[0] && rhs.variables[0]) {
        checkOperator(tokens, lhs.variables[0], op, rhs.variables[0], /^[BSIJFDC]{2}$/);
    }
    return new ResolvedIdent(ident, [Value.build(ident, lhs, rhs, PrimitiveType.map.Z)]);
}

/**
 * @param {TokenList} tokens
 * @param {Local|Parameter|Field|ArrayElement|Value} lhs 
 * @param {Token} op
 * @param {Local|Parameter|Field|ArrayElement|Value} rhs 
 */
function checkOperator(tokens, lhs, op, rhs, re) {
    if (lhs.type instanceof AnyType || rhs.type instanceof AnyType) {
        return;
    }
    let is_comparable = re.test(`${lhs.type.typeSignature}${rhs.type.typeSignature}`);
    if (!is_comparable) {
        addproblem(tokens, ParseProblem.Error(op, `Operator ${op.value} cannot be applied to types '${lhs.type.fullyDottedTypeName}' and '${rhs.type.fullyDottedTypeName}'`));
    }
}

/**
 * @param {TokenList} tokens
 * @param {string} ident 
 * @param {ResolvedIdent} lhs 
 * @param {Token} op 
 * @param {ResolvedIdent} rhs 
 */
function resolveBitwise(tokens, ident, lhs, op, rhs) {
    let type = PrimitiveType.map.I;
    if (lhs.variables[0] && rhs.variables[0]) {
        // ^ is classed as a bitwise operator, but is also a logical operator
        checkOperator(tokens, lhs.variables[0], op, rhs.variables[0], op.value === '^' ? /^[BSIJCZ]{2}$/ : /^[BSIJC]{2}$/);
        if (op.value === '^' && lhs.variables[0].type.typeSignature === 'Z') {
            type = PrimitiveType.map.Z;
        }
    }
    return new ResolvedIdent(ident, [Value.build(ident, lhs, rhs, type)]);
}

/**
 * @param {TokenList} tokens
 * @param {string} ident 
 * @param {ResolvedIdent} lhs 
 * @param {Token} op 
 * @param {ResolvedIdent} rhs 
 */
function resolveLogical(tokens, ident, lhs, op, rhs) {
    if (lhs.variables[0] && rhs.variables[0]) {
        checkOperator(tokens, lhs.variables[0], op, rhs.variables[0], /^ZZ$/);
    }
    return new ResolvedIdent(ident, [Value.build(ident, lhs, rhs, PrimitiveType.map.Z)]);
}

/**
 * @param {TokenList} tokens
 * @param {string} ident 
 * @param {ResolvedIdent} lhs 
 * @param {Token} op 
 * @param {ResolvedIdent} rhs 
 */
function resolveInstanceOf(tokens, ident, lhs, op, rhs) {
    if (!rhs.types[0]) {
        addproblem(tokens, ParseProblem.Error(op, `Operator instanceof requires a type name for comparison.`));
    }
    return new ResolvedIdent(ident, [new Value(ident, PrimitiveType.map.Z)]);
}

/**
 * @param {TokenList} tokens
 * @param {string} ident 
 * @param {ResolvedIdent} lhs 
 * @param {Token} op 
 * @param {ResolvedIdent} rhs 
 */
function resolveMath(tokens, ident, lhs, op, rhs) {
    if (!lhs.variables[0] || !rhs.variables[0]) {
        return new ResolvedIdent(ident);
    }
    if (op.value === '+') {
        // if either side of the + is a string, the result is a string
        for (let operand of [lhs, rhs])
            if (operand.variables[0].type.typeSignature === 'Ljava/lang/String;') {
                return new ResolvedIdent(ident, [Value.build(ident, lhs, rhs, operand.variables[0].type)]);
            }
    }
    checkOperator(tokens, lhs.variables[0], op, rhs.variables[0], /^[BISJFDC]{2}$/);
    /** @type {JavaType} */
    let type;
    const typekey = `${lhs.variables[0].type.typeSignature}${rhs.variables[0].type.typeSignature}`;
    const lhtypematches = 'SB,IB,JB,FB,DB,IS,JS,FS,DS,JI,FI,DI,FJ,DJ,DF';
    if (lhtypematches.indexOf(typekey) >= 0) {
        type = lhs.variables[0].type;
    } else if (/^(C.|.C)$/.test(typekey)) {
        type = PrimitiveType.map.I;
    } else {
        type = rhs.variables[0].type;
    }

    return new ResolvedIdent(ident, [Value.build(ident, lhs, rhs, type)]);
}

/**
 * @param {TokenList} tokens 
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function qualifiedTerm(tokens, locals, method, imports, typemap) {
    let matches = rootTerm(tokens, locals, method, imports, typemap);
    if (tokens.current.kind === 'inc-operator') {
        // postfix inc/dec - only applies to assignable number variables and no qualifiers are allowed to follow
        const postfix_operator = tokens.current;
        tokens.inc();
        const vars = matches.variables.filter(v => /^[BSIJFD]$/.test(v.type.typeSignature))
        if (!vars[0]) {
            addproblem(tokens, ParseProblem.Error(postfix_operator, `Postfix operator cannot be specified here`));
        }
        return new ResolvedIdent(`${matches.source}${postfix_operator.value}`, vars);
    }
    matches = qualifiers(matches, tokens, locals, method, imports, typemap);
    return matches;
}

/**
 * 
 * @param {Token} token 
 */
function isExpressionStart(token) {
    return /^(ident|primitive-type|[\w-]+-literal|(inc|plumin|unary)-operator|open-bracket|new-operator)$/.test(token.kind);
}

/**
 * @param {TokenList} tokens 
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {ResolvedIdent}
 */
function rootTerm(tokens, locals, method, imports, typemap) {
    /** @type {ResolvedIdent} */
    let matches;
    switch(tokens.current.kind) {
        case 'ident':
            matches = resolveIdentifier(tokens, locals, method, imports, typemap);
            break;
        case 'primitive-type':
            matches = new ResolvedIdent(tokens.current.value, [], [], [PrimitiveType.fromName(tokens.current.value)]);
            break;
        case 'string-literal':
            matches = new ResolvedIdent(tokens.current.value, [new LiteralValue(tokens.current.value, typemap.get('java/lang/String'))]);
            break;
        case 'char-literal':
            matches = new ResolvedIdent(tokens.current.value, [new LiteralValue(tokens.current.value, PrimitiveType.map.C)]);
            break;
        case 'boolean-literal':
            matches = new ResolvedIdent(tokens.current.value, [new LiteralValue(tokens.current.value, PrimitiveType.map.Z)]);
            break;
        case 'object-literal':
            // this, super or null
            if (tokens.current.value === 'this') {
                matches = new ResolvedIdent(tokens.current.value, [new Value(tokens.current.value, method._owner)]);
            } else if (tokens.current.value === 'super') {
                const supertype = method._owner.supers.find(s => s.typeKind === 'class') || typemap.get('java/lang/Object');
                matches = new ResolvedIdent(tokens.current.value, [new Value(tokens.current.value, supertype)]);
            } else {
                matches = new ResolvedIdent(tokens.current.value, [new LiteralValue(tokens.current.value, new NullType())]);
            }
            break;
        case /number-literal/.test(tokens.current.kind) && tokens.current.kind:
            matches = new ResolvedIdent(tokens.current.value, [new LiteralValue(tokens.current.value, PrimitiveType.map.I)]);
            break;
        case 'inc-operator':
            let incop = tokens.current;
            tokens.inc();
            matches = qualifiedTerm(tokens, locals, method, imports, typemap);
            const inc_ident = `${incop.value}${matches.source}`;
            if (!matches.variables[0]) {
                return new ResolvedIdent(inc_ident);
            }
            if (matches.variables[0] instanceof Value) {
                addproblem(tokens, ParseProblem.Error(incop, `${incop.value} operator is not valid`));
            }
            return new ResolvedIdent(inc_ident, [new Value(inc_ident, matches.variables[0].type)]);
        case 'plumin-operator':
        case 'unary-operator':
            tokens.inc();
            return qualifiedTerm(tokens, locals, method, imports, typemap);
        case 'new-operator':
            tokens.inc();
            const ctr = qualifiedTerm(tokens, locals, method, imports, typemap);
            let new_ident = `new ${ctr.source}`;
            if (ctr.types[0] instanceof ArrayType) {
                if (tokens.current.value === '{') {
                    // array init
                    rootTerm(tokens, locals, method, imports, typemap);
                }
                return new ResolvedIdent(new_ident, [new Value(new_ident, ctr.types[0])]);
            }
            if (ctr.variables[0] instanceof ConstructorCall) {
                const ctr_type = ctr.variables[0].type;
                if (tokens.current.value === '{') {
                    // final types cannot be inherited
                    if (ctr_type.modifiers.includes('final') ) {
                        addproblem(tokens, ParseProblem.Error(tokens.current, `Type '${ctr_type.fullyDottedTypeName}' is declared final and cannot be inherited from.`));
                    }
                    // anonymous type - just skip for now
                    for (let balance = 0;;) {
                        if (tokens.isValue('{')) {
                            balance++;
                        } else if (tokens.isValue('}')) {
                            if (--balance === 0) {
                                break;
                            }
                        } else tokens.inc();
                    }
                } else {
                    // abstract and interface types must have a type body
                    if (ctr_type.typeKind === 'interface' || ctr_type.modifiers.includes('abstract') ) {
                        addproblem(tokens, ParseProblem.Error(tokens.current, `Type '${ctr_type.fullyDottedTypeName}' is abstract and cannot be instantiated without a body`));
                    }
                }
                return new ResolvedIdent(new_ident, [new Value(new_ident, ctr.variables[0].type)]);
            }
            addproblem(tokens, ParseProblem.Error(tokens.current, 'Constructor expression expected'));
            return new ResolvedIdent(new_ident);
        case 'open-bracket':
            tokens.inc();
            matches = expression(tokens, locals, method, imports, typemap);
            const close_bracket = tokens.current;
            tokens.expectValue(')');
            if (isExpressionStart(tokens.current)) {
                // typecast
                const type = matches.types[0];
                if (!type) {
                    addproblem(tokens, ParseProblem.Error(close_bracket, 'Type expected'));
                }
                const cast_matches = expression(tokens, locals, method, imports, typemap)
                // cast any variables as values with the new type
                const vars = cast_matches.variables.map(v => {
                    if (type && !isTypeCastable(v.type, type)) {
                        addproblem(tokens, ParseProblem.Error(tokens.current, `Expression of type '${v.type.fullyDottedTypeName}' cannot be cast to type '${type.fullyDottedTypeName}'`));
                    }
                    return new Value(v.name, type || v.type);
                });
                return new ResolvedIdent(`(${matches.source})${cast_matches.source}`, vars);
            }
            // the result of a bracketed expression is always a value, never a variable
            // - this prevents things like: (a) = 5;
            const vars = matches.variables.map((v, i, arr) => arr[i] = v instanceof Value ? v : new Value(v.name, v.type));
            return new ResolvedIdent(`(${matches.source})`, vars);
        case tokens.isValue('{') && 'symbol':
            // array initer
            let elements = [];
            if (!tokens.isValue('}')) {
                elements = expressionList(tokens, locals, method, imports, typemap);
                tokens.expectValue('}');
            }
            const ident = `{${elements.map(e => e.source).join(',')}}`;
            return new ResolvedIdent(ident, [new ArrayLiteral(ident, elements)]);
        default:
            addproblem(tokens, ParseProblem.Error(tokens.current, 'Expression expected'));
            return new ResolvedIdent('');
    }
    tokens.inc();
    return matches;
}

/**
 * @param {TokenList} tokens 
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function expressionList(tokens, locals, method, imports, typemap) {
    let e = expression(tokens, locals, method, imports, typemap);
    const expressions = [e];
    while (tokens.current.value === ',') {
        tokens.inc();
        e = expression(tokens, locals, method, imports, typemap);
        expressions.push(e);
    }
    return expressions;
}

/**
 * @param {TokenList} tokens 
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function typeIdentList(tokens, method, imports, typemap) {
    let type = typeIdent(tokens, method, imports, typemap);
    const types = [type];
    while (tokens.current.value === ',') {
        tokens.inc();
        type = typeIdent(tokens, method, imports, typemap);
        types.push(type);
    }
    return types;
}

/**
 * @param {TokenList} tokens 
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function typeIdent(tokens, method, imports, typemap) {
    if (tokens.current.kind !== 'ident') {
        return new UnresolvedType();
    }
    const { types, package_name } = resolveTypeOrPackage(tokens.current.value, method._owner, imports, typemap);
    let matches = new ResolvedIdent(tokens.current.value, [], [], types, package_name);
    for (;;) {
        tokens.inc();
        if (tokens.isValue('.')) {
            matches = parseDottedIdent(matches, tokens, typemap);
        } else if (tokens.isValue('<')) {
            if (!tokens.isValue('>')) {
                typeIdentList(tokens, method, imports, typemap);
                tokens.expectValue('>');
            }
        } else {
            break;
        }
    }
    return matches.types[0] || new UnresolvedType(matches.source);
}

/**
 * @param {TokenList} tokens 
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function arrayIndexOrDimension(tokens, locals, method, imports, typemap) {
    let e = expression(tokens, locals, method, imports, typemap);
    // the value must be a integer-compatible
    const values = e.variables.map(v => new Value(v.name, v.type)).filter(v => /^[BIS]$/.test(v.type.typeSignature));
    if (!values[0]) {
        addproblem(tokens, ParseProblem.Error(tokens.current, 'Invalid array index expression'));
    }
    return new ResolvedIdent(e.source, values);
}

/**
 * @param {TokenList} tokens
 * @param {Token} open_array
 * @param {ResolvedIdent} matches 
 * @param {ResolvedIdent} index
 */
function arrayElementOrConstructor(tokens, open_array, matches, index) {
    const ident = `${matches.source}[${index.source}]`;
    // we must have an array-type variable or at least one type
    const variables = matches.variables
        .filter(v => v.type instanceof ArrayType)
        .map(v => new ArrayElement(v, index));

    const types = matches.types.map(t => t instanceof ArrayType ? new ArrayType(t.base, t.arrdims+1) : new ArrayType(t, 1));

    if (!variables[0] && !types[0]) {
        addproblem(tokens, ParseProblem.Error(open_array, `Invalid array expression`));
    }
    return new ResolvedIdent(ident, variables, [], types);
}

/**
 * @param {TokenList} tokens 
 * @param {ResolvedIdent} instance 
 * @param {ResolvedIdent[]} call_arguments
 * @param {Map<String, JavaType>} typemap
 */
function methodCallExpression(tokens, instance, call_arguments, typemap) {
    const ident = `${instance.source}(${call_arguments.map(arg => arg.source).join(',')})`;

    // method call resolving is painful in Java - we need to match arguments against
    // possible types in the call, but this must include matching against inherited types and choosing the
    // most-specific match
    const methods = instance.methods.filter(m => isCallCompatible(m, call_arguments));
    const types = instance.types.filter(t => {
        // interfaces use Object constructors
        const type = t.typeKind === 'interface'
            ? typemap.get('java/lang/Object')
            : t;
        return type.constructors.find(c => isCallCompatible(c, call_arguments));
    });

    if (!types[0] && !methods[0]) {
        const callargtypes = call_arguments.map(a => a.variables[0] ? a.variables[0].type.fullyDottedTypeName : '<unknown-type>').join(', ');
        if (instance.methods[0]) {
            const methodlist = instance.methods.map(m => m.label).join('\n-  ');
            addproblem(tokens, ParseProblem.Error(tokens.current,
                `No compatible method found. Tried to match:\n-  ${methodlist}\nagainst call argument types: (${callargtypes})`))
            // fake a result with AnyMethod
            methods.push(new AnyMethod(instance.source));
        } else if (instance.types[0]) {
            const ctrlist = instance.types[0].constructors.map(c => c.label).join('\n-  ');
            const match_message = instance.types[0].constructors.length
              ? `Tried to match:\n-  ${ctrlist}\nagainst call argument types: (${callargtypes})`
              : 'The type has no accessible constructors';
            addproblem(tokens, ParseProblem.Error(tokens.current, 
                `No compatible constructor found for type '${instance.types[0].fullyDottedTypeName}'. ${match_message}`));
            // fake a result with AnyType
            types.push(new AnyType(instance.source));
        }
    }

    // the result is a value of the return type of the method or the type
    const variables = [
        ...methods.map(m => new MethodCall(ident, instance, m)),
        ...types.map(t => new ConstructorCall(ident, t))
    ];
    return new ResolvedIdent(ident, variables);
}

/**
 * Returns true if the set of call arguments are assignable to the method or constructor parameters
 * @param {Method|Constructor} m 
 * @param {ResolvedIdent[]} call_arguments 
 */
function isCallCompatible(m, call_arguments) {
    if (m instanceof AnyMethod) {
        return true;
    }
    if (m.parameterCount !== call_arguments.length) {
        // wrong parameter count - this needs updating to support varargs
        return false;
    }
    const p = m.parameters;
    for (let i=0; i < p.length; i++) {
        if (!call_arguments[i].variables[0]) {
            // only variables can be passed - not types or methods
            return false;
        }
        // is the argument assignable to the parameter
        if (isTypeAssignable(p[i].type, call_arguments[i].variables[0].type)) {
            continue;
        }
        // mismatch parameter type
        return;
    }
    return true;
}

/**
 * @param {CEIType} type 
 */
function getTypeInheritanceList(type) {
    const types = {
        /** @type {JavaType[]} */
        list: [type],
        /** @type {Set<JavaType>} */
        done: new Set(),
    };
    for (let type; type = types.list.shift(); ) {
        if (types.done.has(type)) {
            continue;
        }
        types.done.add(type);
        if (type instanceof CEIType)
            types.list.push(...type.supers);
    }
    return Array.from(types.done);
}

class NullType extends JavaType {
    constructor() {
        super('class', [], '');
        super.simpleTypeName = 'null';
    }
    get typeSignature() {
        return 'null';
    }
}


/**
 * @param {ResolvedIdent} matches
 * @param {TokenList} tokens 
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function qualifiers(matches, tokens, locals, method, imports, typemap) {
    for (;;) {
        switch (tokens.current.value) {
            case '.':
                tokens.inc();
                matches = parseDottedIdent(matches, tokens, typemap);
                break;
            case '[':
                let open_array = tokens.current;
                if (tokens.inc().value === ']') {
                    // array type
                    tokens.inc();
                    matches = arrayTypeExpression(matches);
                } else {
                    // array index
                    const index = arrayIndexOrDimension(tokens, locals, method, imports, typemap);
                    matches = arrayElementOrConstructor(tokens, open_array, matches, index);
                    // @ts-ignore
                    tokens.expectValue(']');
                }
                break;
            case '(':
                // method or constructor call
                let args = [];
                if (tokens.inc().value === ')') {
                    tokens.inc();
                } else {
                    args = expressionList(tokens, locals, method, imports, typemap);
                    tokens.expectValue(')');
                }
                matches = methodCallExpression(tokens, matches, args, typemap);
                break;
            case '<':
                // generic type arguments - since this can be confused with less-than, only parse
                // it if there is at least one type and no matching variables
                if (!matches.types[0] || matches.variables[0]) {
                    return matches;
                }
                tokens.inc();
                let type_arguments = [];
                if (!tokens.isValue('>')) {
                    type_arguments = typeIdentList(tokens, method, imports, typemap);
                    tokens.expectValue('>');
                }
                matches.types = matches.types.map(t => {
                    if (t instanceof CEIType) {
                        if (t.typevars.length) {
                            const specialised_type = t.specialise(type_arguments);
                            typemap.set(specialised_type.shortSignature, specialised_type);
                            return specialised_type;
                        }
                    }
                    return t;
                });
                break;
            default:
                return matches;
        }
    }
}

/**
 * @param {ResolvedIdent} matches 
 */
function arrayTypeExpression(matches) {
    const types = matches.types.map(t => {
        if (t instanceof ArrayType) {
            return new ArrayType(t.base, t.arrdims + 1);
        }
        return new ArrayType(t, 1);
    });

    return new ResolvedIdent(`${matches.source}[]`, [], [], types);
}

/**
 * 
 * @param {ResolvedIdent} matches 
 * @param {TokenList} tokens 
 * @param {Map<string,JavaType>} typemap 
 */
function parseDottedIdent(matches, tokens, typemap) {
    let variables = [],
    methods = [],
    types = [],
    package_name = '';
    const qualified_ident = `${matches.source}.${tokens.current.value}`;

    switch (tokens.current.value) {
        case 'class':
            // e.g int.class
            // convert the types to Class instances
            tokens.inc();
            variables = matches.types.map(t => {
                const type_signature = t instanceof AnyType ? '' : `<${t.typeSignature}>`
                return new Value(qualified_ident, signatureToType(`Ljava/lang/Class${type_signature};`, typemap));
            });
            return new ResolvedIdent(qualified_ident, variables);
        case 'this':
            // e.g Type.this - it must be an enclosing type
            // convert the types to 'this' instances
            tokens.inc();
            variables = matches.types.map(t => new Value(qualified_ident, t));
            return new ResolvedIdent(qualified_ident, variables);
    }

    if (tokens.current.kind !== 'ident') {
        addproblem(tokens, ParseProblem.Error(tokens.current, 'Identifier expected'));
        return matches;
    }

    matches.source = qualified_ident;
    // the ident could be a field, method, type or package qualifier
    matches.variables.forEach(v => {
        const decls = v.type.findDeclsByName(tokens.current.value);
        variables.push(...decls.fields);
        methods.push(...decls.methods);
    });
    /** @type {JavaType[]} */
    matches.types.forEach(t => {
        // if there is an AnyType, then add a type, variable and method
        // - this prevents multiple errors in dotted values/
        // e.g R.layout.name wiil only error once (on R), not on all 3 idents
        if (t instanceof AnyType) {
            types.push(new AnyType(qualified_ident));
            variables.push(new AnyValue(qualified_ident));
            methods.push(new AnyMethod(tokens.current.value));
            return;
        }
        if (t instanceof CEIType) {
            const enclosed_type_signature = `${t.shortSignature}$${tokens.current.value}`;
            const enc_type = typemap.get(enclosed_type_signature);
            if (enc_type) {
                types.push(enc_type);
            }
        }
        // search static fields and methods
        const decls = t.findDeclsByName(tokens.current.value);
        variables.push(...decls.fields);
        methods.push(...decls.methods);
    });

    if (matches.package_name) {
        // if there is a package name, the ident could represent a sub-package or a top-leve type name
        const type_match = `${matches.package_name}/${tokens.current.value}`;
        if (typemap.has(type_match)) {
            // it matches a type
            types.push(typemap.get(type_match));
        } else {
            const package_match = `${matches.package_name}/${tokens.current.value}/`;
            if ([...typemap.keys()].find(fqn => fqn.startsWith(package_match))) {
                package_name = type_match;
            }
        }
    }

    const match = new ResolvedIdent(qualified_ident, variables, methods, types, package_name);
    checkIdentifierFound(tokens, tokens.current.value, match);
    tokens.inc();
    return match;
}

/**
 * When resolving identifiers, we need to search across everything because
 * identifiers are context-sensitive.
 * For example, the following compiles even though C takes on different definitions within method:
 * 
 * class A {
 *   class C {
 *   }
 * }
 * 
 * class B extends A {
 *    String C;
 *    int C() {
 *       return C.length();
 *    }
 *    void method() {
 *        C obj = new C();
 *        int x = C.class.getName().length() + C.length() + C();
 *    }
 * }
 * 
 * But... parameters and locals override fields and methods (and local types override enclosed types)
 * 
 * @param {TokenList} tokens
 * @param {Local[]} locals
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function resolveIdentifier(tokens, locals, method, imports, typemap) {
    const ident = tokens.current.value;
    const matches = findIdentifier(ident, locals, method, imports, typemap);
    checkIdentifierFound(tokens, ident, matches);
    return matches;
}

/**
 * @param {TokenList} tokens
 * @param {ResolvedIdent} matches 
 */
function checkIdentifierFound(tokens, ident, matches) {
    if (!matches.variables[0] && !matches.methods[0] && !matches.types[0] && !matches.package_name) {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Unresolved identifier: ${matches.source}`));
        // pretend it matches everything
        matches.variables = [new AnyValue(matches.source)];
        matches.methods = [new AnyMethod(ident)];
        matches.types = [new AnyType(matches.source)];
    }
}

/**
 * @param {string} ident 
 * @param {Local[]} locals 
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports 
 * @param {Map<String,JavaType>} typemap 
 */
function findIdentifier(ident, locals, method, imports, typemap) {
    const matches = new ResolvedIdent(ident);

    // is it a local or parameter - note that locals must be ordered innermost-scope-first
    const local = locals.find(local => local.name === ident);
    const param = method.parameters.find(p => p.name === ident);
    if (local || param) {
        matches.variables = [local || param];
    } else {
        // is it a field or method in the current type (or any of the superclasses)
        const types = getTypeInheritanceList(method._owner);
        const method_sigs = new Set();
        types.forEach(type => {
            if (!matches.variables[0]) {
                const field = type.fields.find(f => f.name === ident);
                if (field) {
                    matches.variables = [field];
                }
            }
            matches.methods = matches.methods.concat(
                type.methods.filter(m => {
                    if (m.name !== ident || method_sigs.has(m.methodSignature)) {
                        return;
                    }
                    method_sigs.add(m.methodSignature);
                    return true;
                })
            );
        });
    }

    const { types, package_name } = resolveTypeOrPackage(ident, method._owner, imports, typemap);
    matches.types = types;
    matches.package_name = package_name;

    return matches;
}

/**
 * 
 * @param {string} ident 
 * @param {CEIType} scoped_type 
 * @param {ResolvedImport[]} imports 
 * @param {Map<string,JavaType>} typemap 
 */
function resolveTypeOrPackage(ident, scoped_type, imports, typemap) {
    const types = [];
    let package_name = '';

    // is it an enclosed type of the currently scoped type or any outer type
    if (scoped_type) {
        const scopes = scoped_type.shortSignature.split('$');
        while (scopes.length) {
            const enc_type = typemap.get(`${scopes.join('$')}$${ident}`);
            if (enc_type) {
                types.push(enc_type);
                break;
            }
            scopes.pop();
        }
    }

    if (!types[0]) {
        // is it a top-level type from the imports
        const top_level_type = '/' + ident;
        for (let i of imports) {
            const fqn = i.fullyQualifiedNames.find(fqn => fqn.endsWith(top_level_type));
            if (fqn) {
                types.push(i.types.get(fqn));
            }
        }
    }

    if (!types[0]) {
        // is it a default-package type 
        const default_type = typemap.get(ident);
        if (default_type) {
            types.push(default_type);
        }
    }

    // the final option is the start of a package name
    const package_root = ident + '/';
    const typelist = [...typemap.keys()];
    if (typelist.find(fqn => fqn.startsWith(package_root))) {
        package_name = ident;        
    }

    return {
        types,
        package_name,
    }
}

/**
 * AnyType is a special type that's used to fill in types that are missing.
 * To prevent cascading errors, AnyType should be fully assign/cast/type-compatible
 * with any other type
 */
class AnyType extends JavaType {
    /**
     * 
     * @param {String} label 
     */
    constructor(label) {
        super("class", [], '');
        super.simpleTypeName = label;
    }

    static Instance = new AnyType('');

    get rawTypeSignature() {
        return 'U';
    }

    get typeSignature() {
        return 'U';
    }
}

class AnyMethod extends Method {
    /**
     * @param {string} name 
     */
    constructor(name) {
        super(name, [], '');
    }

    get returnType() {
        return AnyType.Instance;
    }
}

class Local {
    /**
     * @param {Token[]} modifiers 
     * @param {string} name 
     * @param {Token} decltoken 
     * @param {JavaType} type 
     */
    constructor(modifiers, name, decltoken, type) {
        this.finalToken = modifiers.find(m => m.source === 'final') || null;
        this.name = name;
        this.decltoken = decltoken;
        this.type = type;
        this.init = null;
    }
}

class ArrayElement {
    /**
     * 
     * @param {Local|Parameter|Field|ArrayElement|Value} array_variable 
     * @param {ResolvedIdent} index 
     */
    constructor(array_variable, index) {
        this.array_variable = array_variable;
        this.index = index;
        if (!(this.array_variable.type instanceof ArrayType)) {
            throw new Error('Array element cannot be created from non-array type');
        }
        this.name = `${array_variable.name}[${index.source}]`;
        /** @type {JavaType} */
        this.type = this.array_variable.type.elementType;
    }
}

class Value {
    /**
     * @param {string} name 
     * @param {JavaType} type 
     */
    constructor(name, type) {
        this.name = name;
        this.type = type;
    }

    /**
     * @param {string} ident 
     * @param {ResolvedIdent} lhs 
     * @param {ResolvedIdent} rhs 
     * @param {JavaType} type 
     */
    static build(ident, lhs, rhs, type) {
        const value = lhs.variables && lhs.variables[0] instanceof LiteralValue && rhs.variables && rhs.variables[0] instanceof LiteralValue
            ? new LiteralValue(ident, type)
            : new Value(ident, type);
        return value;
    }
}

class AnyValue extends Value {
    constructor(name) {
        super(name, AnyType.Instance);
    }
}

class LiteralValue extends Value { }

class MethodCall extends Value {
    /**
     * @param {string} name 
     * @param {ResolvedIdent} instance
     * @param {Method} method 
     */
    constructor(name, instance, method) {
        super(name, method.returnType);
        this.instance = instance;
        this.method = method;
    }
}

class ConstructorCall extends Value {
    /**
     * @param {string} name 
     * @param {JavaType} type
     */
    constructor(name, type) {
        super(name, type);
    }
}

class ArrayLiteral extends LiteralValue {
    /**
     * @param {string} name 
     * @param {ResolvedIdent[]} elements 
     */
    constructor(name, elements) {
        super(name, null);
        this.elements = elements;
    }
}

class TernaryValue extends Value {
    /**
     * @param {string} name 
     * @param {JavaType} true_type
     * @param {Token} colon
     * @param {Value} false_value
     */
    constructor(name, true_type, colon, false_value) {
        super(name, true_type);
        this.colon = colon;
        this.falseValue = false_value;
    }
}

class ResolvedIdent {

    /**
     * @param {string} ident 
     * @param {(Local|Parameter|Field|ArrayElement|Value)[]} variables 
     * @param {Method[]} methods 
     * @param {JavaType[]} types 
     * @param {string} package_name 
     */
    constructor(ident, variables = [], methods = [], types = [], package_name = '') {
        this.source = ident;
        this.variables = variables;
        this.methods = methods;
        this.types = types;
        this.package_name = package_name;
    }

}

/**
 *   \s+       whitespace
 *   \/\/.*    single-line comment (slc)
 *   \/\*[\d\D]*?\*\/   multi-line comment (mlc)
 *   "[^\r\n\\"]*(?:\\.[^\r\n\\"]*)*"   string literal - correctly terminated but may contain invalid escapes
 *   ".*       unterminated string literal
 *   '\\?.?'?  character literal - possibly unterminated and/or with invalid escape
 *   \.?\d     number literal (start) - further processing extracts the value
 *   \w+       word - keyword or identifier
 *   [;,?:(){}\[\]]   single-character symbols and operators
 *   \.(\.\.)?    . ...
 * 
 *   the operators: [!=/%*^]=?|<<?=?|>>?[>=]?|&[&=]?|\|[|=]?|\+(=|\++)?|\-+=?
 *   [!=/%*^]=?   ! = / % * ^ != == /= %= *= ^= 
 *   <<?=?        < << <= <<=
 *   >>?[>=]?     > >> >= >>> >>=
 *   &[&=]?       & && &=
 *   \|[|=]?      | || |=
 *   (\+\+|--)     ++ --   postfix inc - only matches if immediately preceded by a word or a ]
 *   [+-]=?       + - += -=
 * 
 * 
 * 
 */
/**
 * 
 * @param {string} source 
 * @param {number} [offset] 
 * @param {number} [length] 
 */
function tokenize(source, offset = 0, length = source.length) {
    const text = source.slice(offset, offset + length);
    const raw_token_re = /(\s+|\/\/.*|\/\*[\d\D]*?\*\/)|("[^\r\n\\"]*(?:\\.[^\r\n\\"]*)*")|(".*)|('\\?.?'?)|(\.?\d)|(\w+)|(\()|([;,?:(){}\[\]@]|\.(?:\.\.)?)|([!=/%*^]=?|<<?=?|>>?>?=?|&[&=]?|\|[|=]?|(\+\+|--)|[+-]=?|~)|$/g;
    const raw_token_types = [
        'wsc',
        'string-literal',
        'unterminated-string-literal',
        'char-literal',
        'number-literal',
        'word',
        'open-bracket',
        'symbol',
        'operator',
    ];
    /**
     * ```
     * true|false    boolean
     * this|null     object
     * int|long|short|byte|float|double|char|boolean|void   primitive type
     * new
     * instanceof
     * public|private|protected|static|final|abstract|native|volatile|transient|synchronized   modifier
     * if|else|while|for|do|try|catch|finally|switch|case|default|return|break|continue    statement keyword
     * class|enum|interface    type keyword
     * package|import    package keyword
     * \w+    word
     * ```
     */
    const word_re = /(?:(true|false)|(this|super|null)|(int|long|short|byte|float|double|char|boolean|void)|(new)|(instanceof)|(public|private|protected|static|final|abstract|native|volatile|transient|synchronized)|(if|else|while|for|do|try|catch|finally|switch|case|default|return|break|continue|throw)|(class|enum|interface)|(package|import)|(\w+))\b/g;
    const word_token_types = [
        'boolean-literal',
        'object-literal',
        'primitive-type',
        'new-operator',
        'instanceof-operator',
        'modifier',
        'statement-kw',
        'type-kw',
        'package-kw',
        'ident'
    ]
    /**
     * ```
     * \d+(?:\.?\d*)?|\.\d+)[eE][+-]?\d*[fFdD]?    decimal exponent: 1e0, 1.5e+10, 0.123E-20d
     * (?:\d+\.\d*|\.\d+)[fFdD]?    decimal number: 0.1, 12.34f, 7.D, .3
     * 0x[\da-fA-F]*[lL]?    hex integer: 0x1, 0xaBc, 0x, 0x7L
     * \d+[fFdDlL]?   integer: 0, 123, 234f, 345L
     * ```
     * todo - underscore seperators
     */
    const number_re = /((?:\d+(?:\.?\d*)?|\.\d+)[eE][+-]?\d*[fFdD]?)|((?:\d+\.\d*|\.\d+)[fFdD]?)|(0x[\da-fA-F]*[lL]?)|(\d+[fFdDlL]?)/g;
    const number_token_types = [
        'dec-exp-number-literal',
        'dec-number-literal',
        'hex-number-literal',
        'int-number-literal',
    ]
    const tokens = [];
    let lastindex = 0, m;
    while (m = raw_token_re.exec(text)) {
        // any text appearing between two matches is invalid
        if (m.index > lastindex) {
            tokens.push(new Token(source, offset + lastindex, m.index - lastindex, 'invalid'));
        }
        lastindex = m.index + m[0].length;
        if (m.index >= text.length) {
            // end of input
            break;
        }

        let idx = m.findIndex((match,i) => i && match) - 1;
        let tokentype = raw_token_types[idx];

        switch(tokentype) {
            case 'number-literal':
                // we need to extract the exact number part
                number_re.lastIndex = m.index;
                m = number_re.exec(text);
                idx = m.findIndex((match,i) => i && match) - 1;
                tokentype = number_token_types[idx];        
                // update the raw_token_re position based on the length of the extracted number
                raw_token_re.lastIndex = lastindex = number_re.lastIndex;
                break;
            case 'word':
                // we need to work out what kind of keyword, literal or ident this is
                word_re.lastIndex = m.index;
                m = word_re.exec(text);
                idx = m.findIndex((match,i) => i && match) - 1;
                tokentype = word_token_types[idx];        
                break;
            case 'operator':
                // find the operator-type
                tokentype = getOperatorType(m[0]);
                break;
        }
        tokens.push(new Token(source, offset + m.index, m[0].length, tokentype));
    }
    
    return tokens;
}


/**
 * ```
 * =|[/%*&|^+-]=|>>>?=|<<=    assignment
 * \+\+|--   inc
 * [!=]=     equality
 * [<>]=?    comparison
 * [&|^]|<<|>>>?    bitwise
 * &&|[|][|]   logical
 * [*%/]   muldiv
 * [+-]   plumin
 * [~!]   unary
 * ```
 */
const operator_re = /^(?:(=|[/%*&|^+-]=|>>>?=|<<=)|(\+\+|--)|([!=]=)|([<>]=?)|([&|^]|<<|>>>?)|(&&|[|][|])|([*%/])|([+-])|([~!]))$/;
/**
 * @typedef {
    'assignment-operator'|
    'inc-operator'|
    'equality-operator'|
    'comparison-operator'|
    'bitwise-operator'|
    'logical-operator'|
    'muldiv-operator'|
    'plumin-operator'|
    'unary-operator'} OperatorKind
 */
/** @type {OperatorKind[]} */
const operator_token_types = [
    'assignment-operator',
    'inc-operator',
    'equality-operator',
    'comparison-operator',
    'bitwise-operator',
    'logical-operator',
    'muldiv-operator',
    'plumin-operator',
    'unary-operator',
]
/**
 * @param {string} value 
 */
function getOperatorType(value) {
    const op_match = value.match(operator_re);
    const idx = op_match.findIndex((match,i) => i && match) - 1;
    // @ts-ignore
    return operator_token_types[idx];
}

class Token extends TextBlock {

    /**
     * 
     * @param {string} text 
     * @param {number} start 
     * @param {number} length 
     * @param {string} kind 
     */
    constructor(text, start, length, kind) {
        super(new BlockRange(text, start, length), null);
        this.kind = kind;
    }

    get value() {
        return this.source;
    }
}

function testTokenize() {
    const tests = [
        // the basics
        { src: 'i', r: [{value: 'i', kind:'ident'}] },
        { src: '0', r: [{value: '0', kind:'int-number-literal'}] },
        { src: `""`, r: [{value: `""`, kind:'string-literal'}] },
        { src: `'x'`, r: [{value: `'x'`, kind:'char-literal'}] },
        { src: `(`, r: [{value: `(`, kind:'open-bracket'}] },
        ...'. , [ ] ? : @'.split(' ').map(symbol => ({ src: symbol, r: [{value: symbol, kind: 'symbol'}] })),
        ...'= += -= *= /= %= >>= <<= &= |= ^='.split(' ').map(op => ({ src: op, r: [{value: op, kind:'assignment-operator'}] })),
        ...'+ -'.split(' ').map(op => ({ src: op, r: [{value: op, kind:'plumin-operator'}] })),
        ...'* / %'.split(' ').map(op => ({ src: op, r: [{value: op, kind:'muldiv-operator'}] })),
        ...'# ¬'.split(' ').map(op => ({ src: op, r: [{value: op, kind:'invalid'}] })),

        // numbers - decimal with exponent
        ...'0.0e+0 0.0E+0 0e+0 0e0 .0e0 0e0f 0e0d'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'dec-exp-number-literal'}] })),
        // numbers - decimal with partial exponent
        ...'0.0e+ 0.0E+ 0e+ 0e .0e 0ef 0ed'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'dec-exp-number-literal'}] })),
        // numbers - not decimal exponent
        { src: '0.0ea', r: [{value: '0.0e', kind:'dec-exp-number-literal'}, {value: 'a', kind:'ident'}] },

        // numbers - decimal (no exponent)
        ...'0.123 0. 0.f 0.0D .0 .0f .123D'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'dec-number-literal'}] })),
        // numbers - not decimal
        { src: '0.a', r: [{value: '0.', kind:'dec-number-literal'}, {value: 'a', kind:'ident'}] },
        { src: '0.0a', r: [{value: '0.0', kind:'dec-number-literal'}, {value: 'a', kind:'ident'}] },

        // numbers - hex
        ...'0x0 0x123456789abcdef 0xABCDEF 0xabcdefl'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'hex-number-literal'}] })),
        // numbers - partial hex
        ...'0x 0xl'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'hex-number-literal'}] })),

        // numbers - decimal
        ...'0 123456789 0l'.split(' ').map(num => ({ src: num, r: [{value: num, kind:'int-number-literal'}] })),

        // strings
        ...[`"abc"`, `"\\n"`, `"\\""`].map(num => ({ src: num, r: [{value: num, kind:'string-literal'}] })),
        // unterminated strings
        ...[`"abc`, `"\\n`, `"\\"`, `"`].map(num => ({ src: num, r: [{value: num, kind:'unterminated-string-literal'}] })),
        // strings cannot cross newlines
        { src: `"abc\n`, r: [{value: `"abc`, kind:'unterminated-string-literal'}, {value: '\n', kind:'wsc'}] },

        // characters
        ...[`'a'`, `'\\n'`, `'\\''`].map(num => ({ src: num, r: [{value: num, kind:'char-literal'}] })),
        // unterminated/invalid characters
        ...[`'a`, `'\\n`, `'\\'`, `''`, `'`].map(num => ({ src: num, r: [{value: num, kind:'char-literal'}] })),
        // characters cannot cross newlines
        { src: `'\n`, r: [{value: `'`, kind:'char-literal'}, {value: '\n', kind:'wsc'}] },

        // arity symbol
        { src: `int...x`, r: [
            {value: `int`, kind:'primitive-type'},
            {value: `...`, kind:'symbol'},
            {value: `x`, kind:'ident'},
        ],},

        // complex inc - the javac compiler doesn't bother to try and sensibly separate +++ - it just appears to 
        // prioritise ++ in every case, assuming that the developer will insert spaces as required.
        // e.g this first one fails to compile with javac
        { src: '++abc+++def', r: [
            {value: '++', kind:'inc-operator'},
            {value: 'abc', kind:'ident'},
            {value: '++', kind:'inc-operator'},
            {value: '+', kind:'plumin-operator'},
            {value: 'def', kind:'ident'},
        ] },
        // this should be ok
        { src: '++abc+ ++def', r: [
            {value: '++', kind:'inc-operator'},
            {value: 'abc', kind:'ident'},
            {value: '+', kind:'plumin-operator'},
            {value: ' ', kind:'wsc'},
            {value: '++', kind:'inc-operator'},
            {value: 'def', kind:'ident'},
        ] },
    ]
    const report = (test, msg) => {
        console.log(JSON.stringify({test, msg}));
    }
    tests.forEach(t => {
        const tokens = tokenize(t.src);
        if (tokens.length !== t.r.length) {
            report(t, `Wrong token count. Expected ${t.r.length}, got ${tokens.length}`);
            return;
        }
        for (let i=0; i < tokens.length; i++) {
            if (tokens[i].value !== t.r[i].value)
                report(t, `Wrong token value. Expected ${t.r[i].value}, got ${tokens[i].value}`);
            if (tokens[i].kind !== t.r[i].kind)
                report(t, `Wrong token kind. Expected ${t.r[i].kind}, got ${tokens[i].kind}`);
        }
    })
}


testTokenize();

// const s = require('fs').readFileSync('/home/dave/dev/vscode/android-dev-ext/langserver/tests/java-files/View-25.java', 'utf8');
// console.time();
// const tokens = tokenize(s);
// console.timeEnd();
// if (tokens.map(t => t.value).join('') !== s) {
//     console.log('mismatch');
// }

// testTokenize();

exports.parseBody = parseBody;
