/**
 * Method body parsing is entirely linear and relies upon type processing being completed so
 * we can resolve packages, types, fields, methods, parameters and locals along the way.
 * 
 * Each token also contains detailed state information used for completion suggestions.
 */
const { JavaType, CEIType, PrimitiveType, ArrayType, UnresolvedType, NullType, WildcardType, TypeVariable, Field, Method, ReifiedMethod, Parameter, Constructor, signatureToType } = require('java-mti');
const { SourceMethod, SourceConstructor, SourceInitialiser } = require('./source-type');
const ResolvedImport = require('./parsetypes/resolved-import');
const ParseProblem = require('./parsetypes/parse-problem');
const { getOperatorType, Token } = require('./tokenizer');
const { resolveTypeOrPackage, resolveNextTypeOrPackage } = require('./type-resolver');
const { genericTypeArgs } = require('./typeident');
const { TokenList } = require("./TokenList");
const { AnyMethod, AnyType, AnyValue, ArrayElement, ArrayLiteral, ConstructorCall, LiteralNumber, LiteralValue, Local, MethodCall, ResolvedIdent, TernaryValue, Value } = require("./body-types");

/**
 * @typedef {SourceMethod|SourceConstructor|SourceInitialiser} SourceMC
 */


/**
 * @param {*[]} blocks 
 * @param {boolean} isMethod 
 */
function flattenBlocks(blocks, isMethod) {
    return blocks.reduce((arr,block) => {
        if (block instanceof Token) {
            // 'default' and 'synchronised' are not modifiers inside method bodies
            if (isMethod && block.kind === 'modifier' && /^(default|synchronized)$/.test(block.value)) {
                block.kind = 'statement-kw'
                block.simplified = block.value;
            }
            arr.push(block);
        } else {
            arr = [...arr, ...flattenBlocks(block.blockArray().blocks, isMethod)];
        }
        return arr;
    }, [])
}

/**
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function parseBody(method, imports, typemap) {
    const body = method._decl.body().blockArray();
    if (!body || body.blocks[0].value !== '{') {
        return null;
    }
    const tokenlist = new TokenList(flattenBlocks(body.blocks, true));
    let block = null;
    try {
        block = statementBlock(tokenlist, [], method, imports, typemap);
    } catch (err) {
        addproblem(tokenlist, ParseProblem.Information(tokenlist.current, `Parse failed: ${err.message}`));

    }
    return {
        block,
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
class SynchronizedStatement extends Statement {
    /** @type {ResolvedIdent} */
    expression = null;
    /** @type {Statement} */
    statement = null;
}
class AssertStatement extends Statement {
    expression = null;
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
        case 'synchronized':
            tokens.inc();
            s = new SynchronizedStatement();
            synchronizedStatement(s, tokens, locals, method, imports, typemap);
            break;
        case 'assert':
            tokens.inc();
            s = new AssertStatement();
            s.expression = expression(tokens, locals, method, imports, typemap);
            semicolon(tokens);
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
    if (e.variables[0] && !isTypeAssignable(PrimitiveType.map.Z, e.variables[0].type)) {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Boolean expression expected, but type '${e.variables[0].type.fullyDottedTypeName}' found`));
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
* @param {SynchronizedStatement} s
* @param {TokenList} tokens 
* @param {Local[]} locals
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function synchronizedStatement(s, tokens, locals, method, imports, typemap) {
    tokens.expectValue('(');
    s.expression = expression(tokens, locals, method, imports, typemap);
    if (s.expression.variables[0]) {
        if (s.expression.variables[0].type instanceof PrimitiveType) {
            addproblem(tokens, ParseProblem.Error(tokens.current, `synchronized lock expression must be a reference type`));
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
                exceptionVar = new Local(mods, catchinfo.name.value, catchinfo.name, catchinfo.types[0], 0);
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
                if (test_type && !isAssignable(test_type, e.variables[0])) {
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
    if (v instanceof AnyValue) {
        return true;
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
    const expr = return_expression.variables[0];
    if (!expr) {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Method must return a value of type '${method.returnType.fullyDottedTypeName}'`));
        return;
    }
    const is_assignable = isAssignable(method.returnType, expr);
    if (!is_assignable) {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Incompatible types: Expression of type '${expr.type.fullyDottedTypeName}' cannot be returned from a method of type '${method.returnType.fullyDottedTypeName}'`));
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
    let is_throwable = isAssignable(typemap.get('java/lang/Throwable'), throw_expression.variables[0]);
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
            const name = tokens.current;
            tokens.inc();
            // look for [] after the variable name
            let postnamearrdims = 0;
            while (tokens.isValue('[')) {
                postnamearrdims += 1;
                tokens.expectValue(']');
            }
            let local = new Local(mods, name.value, name, matches.types[0], postnamearrdims);
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
        if (!/^(assignment|equality|comparison|bitwise|shift|logical|muldiv|plumin|instanceof)-operator/.test(tokens.current.kind) && !/\?/.test(tokens.current.value)) {
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
        case 'shift-operator':
            return resolveShift(tokens, ident, lhs, op, rhs);
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
                // ^&| are both bitwise and logical operators
                checkOperator(tokens, lhsvar, op, rhsvar, /^[BSIJCZ]{2}$/);
                rhsvar = new Value(rhs.source, lhsvar.type);
                break;
            case "shift-operator":
                checkOperator(tokens, lhsvar, op, rhsvar, /^[BSIJC]{2}$/);
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

    is_assignable = isAssignable(variable.type, value);
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
                is_assignable = element.variables[0] ? isAssignable(required_element_type, element.variables[0]) : false;
            }
        } else {
            // base type = the element must match the (non-array) type
            if (element instanceof ArrayLiteral) {
                is_assignable = false;
            } else {
                is_assignable = element.variables[0] ? isAssignable(required_element_type, element.variables[0]) : false;
            }
        }
        if (!is_assignable) {
            return false;
        }
    }
    return true;
}

/**
 * 
 * @param {JavaType} type 
 * @param {Local|Parameter|Field|ArrayElement|Value} value 
 */
function isAssignable(type, value) {
    if (value instanceof LiteralNumber) {
        return value.isCompatibleWith(type);
    }

    return isTypeAssignable(type, value.type);
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
    if (source_type instanceof NullType) {
        // null is castable to any non-primitive
        return !(cast_type instanceof PrimitiveType);
    }
    if (source_type instanceof CEIType && cast_type instanceof CEIType) {
        if (source_type.typeKind === 'interface') {
            // interfaces are castable to any non-final class type (derived types might implement the interface)
            if (cast_type.typeKind === 'class' && !cast_type.modifiers.includes('final')) {
                return true;
            }
        }
        // for other class casts, one type must be in the inheritence tree of the other
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
            case 'J': 
            case 'C': 
            case 'F':
            case 'D':
                return /^([BSIJCFD]|Ljava\/lang\/(Byte|Short|Integer|Long|Character|Float|Double);)$/.test(source_type.typeSignature);
            case 'Z':
                return /^([Z]|Ljava\/lang\/(Boolean);)$/.test(source_type.typeSignature);
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
const valid_primitive_types = {
    // conversions from a primitive to a value
    from: {
        B: /^[BSIJFD]$|^Ljava\/lang\/(Byte|Short|Integer|Long|Float|Double);$/,
        S: /^[SIJFD]$|^Ljava\/lang\/(Short|Integer|Long|Float|Double);$/,
        I: /^[IJFD]$|^Ljava\/lang\/(Integer|Long|Float|Double);$/,
        J: /^[JFD]$|^Ljava\/lang\/(Long|Float|Double);$/,
        F: /^[FD]$|^Ljava\/lang\/(Float|Double);$/,
        D: /^D$|^Ljava\/lang\/(Double);$/,
        C: /^[CIJFD]$|^Ljava\/lang\/(Character|Integer|Long|Float|Double);$/,
        Z: /^Z$|^Ljava\/lang\/(Boolean);$/,
        V: /$^/,    // V.test() always returns false
    },
    // conversions to a primitive from a value
    to: {
        B: /^[B]$|^Ljava\/lang\/(Byte);$/,
        S: /^[BS]$|^Ljava\/lang\/(Byte|Short);$/,
        I: /^[BSIC]$|^Ljava\/lang\/(Byte|Short|Integer|Character);$/,
        J: /^[BSIJC]$|^Ljava\/lang\/(Byte|Short|Integer|Long|Character);$/,
        F: /^[BSIJCF]$|^Ljava\/lang\/(Byte|Short|Integer|Long|Character|Float);$/,
        D: /^[BSIJCFD]$|^Ljava\/lang\/(Byte|Short|Integer|Long|Character|Float|Double);$/,
        C: /^C$|^Ljava\/lang\/(Character);$/,
        Z: /^Z$|^Ljava\/lang\/(Boolean);$/,
        V: /$^/,    // V.test() always returns false
    }
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
        // primitive values can only be assigned to wider primitives or their class equivilents
        is_assignable = valid_primitive_types.from[value_type.typeSignature].test(dest_type.typeSignature);
    } else if (dest_type instanceof PrimitiveType) {
        // primitive variables can only be assigned from narrower primitives or their class equivilents
        is_assignable = valid_primitive_types.to[dest_type.typeSignature].test(value_type.typeSignature);
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
            if (!is_assignable) {
                // generic types are also assignable to compatible wildcard type bounds
                const raw_type = valid_raw_types.find(rt => rt.rawTypeSignature === dest_type.rawTypeSignature);
                if (raw_type instanceof CEIType && raw_type.typeVariables.length === value_type.typeVariables.length) {
                    is_assignable = dest_type.typeVariables.every((dest_tv, idx) => isTypeArgumentCompatible(dest_tv, value_type.typeVariables[idx].type));
                }
            }
        }
    }
    return is_assignable;
}

/**
 * @param {TypeVariable} dest_typevar 
 * @param {JavaType} value_typevar_type
 */
function isTypeArgumentCompatible(dest_typevar, value_typevar_type) {
    if (dest_typevar.type instanceof WildcardType) {
        if (!dest_typevar.type.bound) {
            // unbounded wildcard types are compatible with everything
            return true;
        }
        if (dest_typevar.type.bound.type === value_typevar_type) {
            return true;
        }
        switch (dest_typevar.type.bound.kind) {
            case 'extends':
                return isTypeAssignable(dest_typevar.type.bound.type, value_typevar_type);
            case 'super':;
                return isTypeAssignable(value_typevar_type, dest_typevar.type.bound.type);
        }
        return false;
    }
    return dest_typevar.type === value_typevar_type;
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
 * @param {JavaType} lhs_type 
 * @param {JavaType} rhs_type 
 */
function isTypeComparable(lhs_type, rhs_type) {
    let is_comparable;
    if (lhs_type.typeSignature === rhs_type.typeSignature) {
        is_comparable = true;
    } else if (lhs_type instanceof AnyType || rhs_type instanceof AnyType) {
        is_comparable = true;
    } else if (lhs_type instanceof PrimitiveType) {
        const valid_rhs_type = {
            Z: /^Z$/,
            V: /^$/,
        }[lhs_type.typeSignature] || /^[BSIJFDC]$/;
        is_comparable = valid_rhs_type.test(rhs_type.typeSignature);
    } else if (lhs_type instanceof NullType || rhs_type instanceof NullType) {
        is_comparable = !(rhs_type instanceof PrimitiveType);
    } else if (lhs_type instanceof ArrayType) {
        const base_type = lhs_type.base;
        const valid_array_types = base_type instanceof CEIType ? getTypeInheritanceList(base_type) : [base_type];
        is_comparable = rhs_type.typeSignature === 'Ljava/lang/Object;'
          || (rhs_type instanceof ArrayType 
                && rhs_type.arrdims === rhs_type.arrdims
                && valid_array_types.includes(rhs_type));
    } else if (lhs_type instanceof CEIType && rhs_type instanceof CEIType) {
        const lhs_types = getTypeInheritanceList(lhs_type);
        const rhs_types = getTypeInheritanceList(rhs_type);
        is_comparable = lhs_types.includes(rhs_type) || rhs_types.includes(lhs_type);
        if (!is_comparable) {
            if (lhs_type.rawTypeSignature === rhs_type.rawTypeSignature) {
                is_comparable = lhs_type.typeVariables.every((tv, idx) => isTypeArgumentComparable(tv, rhs_type.typeVariables[idx]));
            }
        }
    }
    return is_comparable;
}

/**
 * @param {TypeVariable} a 
 * @param {TypeVariable} b
 */
function isTypeArgumentComparable(a, b) {
    let a_type = a.type, b_type = b.type;
    if (a_type === b_type) {
        return true;
    }
    if (a_type instanceof WildcardType) {
        if (!a_type.bound)
            return true; // unbounded wildcard types are comparable with everything
        if (a_type.bound.type.typeKind === 'interface')
            return true; // interface bounds are comparable with everything
    }
    if (b_type instanceof WildcardType) {
        if (!b_type.bound)
            return true; // unbounded wildcard types are comparable with everything
        if (b_type.bound.type.typeKind === 'interface')
            return true; // interface bounds are comparable with everything
    }
    /**
     * 
     * @param {JavaType} type 
     * @param {JavaType} list_type 
     */
    function extendsFrom(type, list_type) {
        if (!(list_type instanceof CEIType)) {
            return false;
        }
        return list_type === type || getTypeInheritanceList(list_type).includes(type);
    }
    // each type argument can have 3 possible states
    // - a extends, a super, a (exact)
    // - b extends, b super, b (exact)
    // we need to cover all combinations of a and b...
    if (a_type instanceof WildcardType && a_type.bound.kind === 'extends') {
        if (b_type instanceof WildcardType && b_type.bound.kind === 'extends') {
            // both are extends - one must extend from the other
            return extendsFrom(a_type.bound.type, b_type.bound.type) || extendsFrom(b_type.bound.type, a_type.bound.type);
        }
        else if (b_type instanceof WildcardType && b_type.bound.kind === 'super') {
            // a extends, b super - b must extend from a
            return extendsFrom(a_type.bound.type, b_type.bound.type);
        } else {
            // b is an exact type - b must extend from a
            return extendsFrom(a_type.bound.type, b_type);
        }
    }
    else if (a_type instanceof WildcardType && a_type.bound.kind === 'super') {
        if (b_type instanceof WildcardType && b_type.bound.kind === 'super') {
            // both are super - one must extend from the other
            return extendsFrom(a_type.bound.type, b_type.bound.type) || extendsFrom(b_type.bound.type, a_type.bound.type);
        }
        else if (b_type instanceof WildcardType && b_type.bound.kind === 'extends') {
            // a super, b extends - a must extend from b
            return extendsFrom(b_type.bound.type, a_type.bound.type);
        } else {
            // b is an exact type - a must extend from b
            return extendsFrom(b_type, a_type.bound.type);
        }
    } else {
        // a is an exact type
        if (b_type instanceof WildcardType && b_type.bound.kind === 'extends') {
            // a exact, b extends - a must extend from b
            return extendsFrom(b_type.bound.type, a_type);
        }
        else if (b_type instanceof WildcardType && b_type.bound.kind === 'super') {
            // a exact, b super - b must extend from a
            return extendsFrom(a_type, b_type.bound.type);
        }
    }
    return false;
}

/**
 * @param {TokenList} tokens
 * @param {Local|Parameter|Field|ArrayElement|Value} lhs 
 * @param {Token} op
 * @param {Local|Parameter|Field|ArrayElement|Value} rhs 
 */
function checkEqualityComparison(tokens, lhs, op, rhs) {
    const is_comparable = isTypeComparable(lhs.type, rhs.type);
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
    const lhsvar = lhs.variables[0], rhsvar = rhs.variables[0];
    if (lhsvar && rhsvar) {
        // ^&| are both bitwse and logical operators
        checkOperator(tokens, lhsvar, op, rhsvar, /^[BSIJCZ]{2}$/);
        if (lhsvar.type.typeSignature === 'Z') {
            type = PrimitiveType.map.Z;
        }
        else if (lhsvar instanceof LiteralNumber && rhsvar instanceof LiteralNumber) {
            const result = LiteralNumber[op.value](lhsvar, rhsvar);
            if (result) {
                return new ResolvedIdent(ident, [result]);
            }
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
function resolveShift(tokens, ident, lhs, op, rhs) {
    const lhsvar = lhs.variables[0], rhsvar = rhs.variables[0];
    if (lhsvar && rhsvar) {
        // ^&| are both bitwse and logical operators
        checkOperator(tokens, lhsvar, op, rhsvar, /^[BSIJC]{2}$/);
        if (lhsvar instanceof LiteralNumber && rhsvar instanceof LiteralNumber) {
            const result = LiteralNumber[op.value](lhsvar, rhsvar);
            if (result) {
                return new ResolvedIdent(ident, [result]);
            }
        }
    }
    return new ResolvedIdent(ident, [Value.build(ident, lhs, rhs, PrimitiveType.map.I)]);
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
    const lhsvar = lhs.variables[0], rhsvar = rhs.variables[0];
    if (!lhsvar || !rhsvar) {
        return new ResolvedIdent(ident);
    }
    if (op.value === '+') {
        // if either side of the + is a string, the result is a string
        for (let operand of [lhs, rhs])
            if (operand.variables[0].type.typeSignature === 'Ljava/lang/String;') {
                return new ResolvedIdent(ident, [Value.build(ident, lhs, rhs, operand.variables[0].type)]);
            }
    }
    checkOperator(tokens, lhsvar, op, rhsvar, /^[BISJFDC]{2}$/);
    if (lhsvar instanceof LiteralNumber && rhsvar instanceof LiteralNumber) {
        const result = LiteralNumber[op.value](lhsvar, rhsvar);
        if (result) {
            return new ResolvedIdent(ident, [result]);
        }
    }
/** @type {JavaType} */
    let type;
    const typekey = `${lhsvar.type.typeSignature}${rhsvar.type.typeSignature}`;
    const lhtypematches = 'SB,IB,JB,FB,DB,IS,JS,FS,DS,JI,FI,DI,FJ,DJ,DF';
    if (lhtypematches.indexOf(typekey) >= 0) {
        type = lhsvar.type;
    } else if (/^(C.|.C)$/.test(typekey)) {
        type = PrimitiveType.map.I;
    } else {
        type = rhsvar.type;
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
 * @param {Token} token first token following the close bracket
 * @param {ResolvedIdent} matches - the bracketed expression
 */
function isCastExpression(token, matches) {
    // working out if this is supposed to be a cast expression is problematic.
    //   (a) + b     -> cast or binary expression (depends on how a is resolved)
    // if the bracketed expression cannot be resolved:
    //   (a) b     -> assumed to be a cast
    //   (a) + b   -> assumed to be an expression
    //   (a) 5   -> assumed to be a cast
    //   (a) + 5   -> assumed to be an expression
    if (matches.types[0] && !(matches.types[0] instanceof AnyType)) {
        // resolved type - this must be a cast
        return true;
    }
    if (!matches.types[0]) {
        // not a type - this must be an expression
        return false;
    }
    // if we reach here, the type is AnyType - we assume a cast if the next
    // value is the start of an expression, except for +/-
    if (token.kind === 'plumin-operator') {
        return false;
    }
    return this.isExpressionStart(token);
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
                matches = new ResolvedIdent(tokens.current.value, [new Value(tokens.current.value, method.owner)]);
            } else if (tokens.current.value === 'super') {
                const supertype = method.owner.supers.find(s => s.typeKind === 'class') || typemap.get('java/lang/Object');
                matches = new ResolvedIdent(tokens.current.value, [new Value(tokens.current.value, supertype)]);
            } else {
                matches = new ResolvedIdent(tokens.current.value, [new LiteralValue(tokens.current.value, new NullType())]);
            }
            break;
        case /number-literal/.test(tokens.current.kind) && tokens.current.kind:
            matches = new ResolvedIdent(tokens.current.value, [LiteralNumber.from(tokens.current)]);
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
            if (isCastExpression(tokens.current, matches)) {
                // typecast
                const type = matches.types[0];
                if (!type) {
                    addproblem(tokens, ParseProblem.Error(close_bracket, 'Type expected'));
                }
                const cast_matches = qualifiedTerm(tokens, locals, method, imports, typemap)
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
        addproblem(tokens, ParseProblem.Error(open_array, `Invalid array expression: '${matches.source}' is not an array type`));
        variables.push(new ArrayElement(new Value(matches.source, new ArrayType(AnyType.Instance, 1)), index));
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
    const methods = [];
    instance.methods.forEach(m => {
        if (m.typeVariables.length) {
            // if the method is declared with type variables, specialise it based upon the argument types
            m = ReifiedMethod.build(m, call_arguments.map(arg => arg.variables[0].type));
        }
        if (isCallCompatible(m, call_arguments)) {
            methods.push(m);
        }
    });
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
        if (isAssignable(p[i].type, call_arguments[i].variables[0])) {
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
                genericTypeArgs(tokens, matches.types, method, imports, typemap);
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
            const prim_map = {
                B:'Byte',S:'Short',I:'Integer',J:'Long',F:'Float',D:'Double',C:'Character',Z:'Boolean',V:'Void',
            }
            variables = matches.types.map(t => {
                const type_signature = t instanceof AnyType
                    ? ''
                    : t instanceof PrimitiveType
                    ? `<Ljava/lang/${prim_map[t.typeSignature]};>`
                    : `<${t.typeSignature}>`
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
        // e.g R.layout.name will only error once (on R), not on all 3 idents
        if (t instanceof AnyType) {
            types.push(new AnyType(qualified_ident));
            variables.push(new AnyValue(qualified_ident));
            methods.push(new AnyMethod(tokens.current.value));
            return;
        }
        // search static fields and methods
        const decls = t.findDeclsByName(tokens.current.value);
        variables.push(...decls.fields);
        methods.push(...decls.methods);
    });

    const members = resolveNextTypeOrPackage(tokens.current.value, matches.types, matches.package_name, typemap);

    const match = new ResolvedIdent(qualified_ident, variables, methods, [...types, ...members.types ], members.package_name);
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
        const types = getTypeInheritanceList(method.owner);
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

    const { types, package_name } = resolveTypeOrPackage(ident, method, imports, typemap);
    matches.types = types;
    matches.package_name = package_name;

    return matches;
}


exports.addproblem = addproblem;
exports.parseBody = parseBody;
exports.flattenBlocks = flattenBlocks;
