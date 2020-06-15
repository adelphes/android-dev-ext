/**
 * Method body parsing is entirely linear and relies upon type processing being completed so
 * we can resolve packages, types, fields, methods, parameters and locals along the way.
 * 
 * Each token also contains detailed state information used for completion suggestions.
 */
const { JavaType, CEIType, PrimitiveType, ArrayType, UnresolvedType, NullType, WildcardType, TypeVariableType,
    TypeVariable, InferredTypeArgument, Field, Method, ReifiedMethod, Parameter, Constructor, signatureToType } = require('java-mti');
const { SourceType, SourceTypeIdent, SourceField, SourceMethod, SourceConstructor, SourceInitialiser, SourceParameter, SourceAnnotation,
    SourceUnit, SourcePackage, SourceImport } = require('./source-types2');
const ResolvedImport = require('./parsetypes/resolved-import');
const ParseProblem = require('./parsetypes/parse-problem');
const { getOperatorType, tokenize, Token } = require('./tokenizer');
const { resolveTypeOrPackage, resolveNextTypeOrPackage } = require('./type-resolver');
const { genericTypeArgs, typeIdent, typeIdentList } = require('./typeident');
const { TokenList } = require("./TokenList");
const { AnyMethod, AnyType, AnyValue, ArrayElement, ArrayLiteral, ConstructorCall, Label, LiteralNumber, LiteralValue, Local,
    MethodCall, MethodDeclarations, ResolvedIdent, TernaryValue, Value } = require("./body-types");
const { resolveImports, resolveSingleImport } = require('../java/import-resolver');

/**
 * @typedef {SourceMethod|SourceConstructor|SourceInitialiser} SourceMC
 * @typedef {SourceType|SourceMC} Scope
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
 * @param {SourceMethod | SourceConstructor | SourceInitialiser} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function parseBody(method, imports, typemap) {
    const body = method.body;
    if (!body || body[0].value !== '{') {
        return null;
    }
    const tokenlist = new TokenList(flattenBlocks(body, true));
    let block = null;
    let mdecls = new MethodDeclarations();
    try {
        block = statementBlock(tokenlist, mdecls, method, imports, typemap);
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
 * @param {TokenList} tokens 
 * @param {*} typemap 
 */
function extractSourceTypes(tokens, typemap) {
    // first strip out any comments, chars, strings etc which might confuse the parsing
    const normalised_source = tokens.tokens.map(t => {
        return /wsc|string-literal|char-literal/.test(t.kind) 
          ? ' '.repeat(t.length)
          : t.source
    }).join('')
    
    // look for scope boundaries, package and type declarations
    const re = /(\{)|(\})|\bpackage +(\w+(?: *\. *\w+)*)|\b(class|enum|interface|@ *interface) +(\w+)/g;
    let package_name = null;
    let type_stack = [];
    let code_balance = 0;
    const source_types = [];
    function findTokenAt(idx) {
        return tokens.tokens.find(t => t.range.start === idx);        
    }
    for (let m; m = re.exec(normalised_source);) {
        if (code_balance) {
            if (m[1]) code_balance += 1;
            else if (m[2]) code_balance -= 1;
            continue;
        }
        if (m[1]) {
            // open brace
            if (!type_stack[0]) {
                continue;   // ignore - we haven't started a type yet
            }
            if (!type_stack[0].type_open) {
                type_stack[0].type_open = true; // start of type body
                continue;
            }
            // start of method body or array expression
            code_balance = 1;
        } else if (m[2]) {
            // close brace
            if (!type_stack[0]) {
                continue;   // we're outside any type
            }
            type_stack.shift();
        } else if (m[3]) {
            // package name
            if (package_name !== null) {
                continue;   // ignore - we already have a package name or started parsing types
            }
            package_name = m[3].replace(/ +/g, '');
        } else if (m[4]) {
            // named type decl
            package_name = package_name || '';
            const typeKind = m[4].replace(/ +/g, ''),
              kind_token = findTokenAt(m.index),
              name_token = findTokenAt(m.index + m[0].match(/\w+$/).index),
              outer_type = type_stack[0] && type_stack[0].source_type,
              source_type = new SourceType(package_name, outer_type, '', [], typeKind, kind_token, name_token, typemap);
              
            type_stack.unshift({
                source_type,
                type_open: false,
            });
            source_types.unshift(source_type);
        }
    }
    console.log(source_types.map(t => t.shortSignature))
    return source_types;
}

/**
 * @param {string} source
 * @param {Map<string,JavaType>} typemap 
 */
function parse(source, typemap) {
    const unit = new SourceUnit();
    let tokens;
    try {
        console.time('tokenize');
        tokens = new TokenList(tokenize(source));
        console.timeEnd('tokenize');

        // in order to resolve types as we parse, we must extract the set of source types first
        const source_types = extractSourceTypes(tokens, typemap);
        // add them to the type map
        source_types.forEach(t => typemap.set(t.shortSignature, t));

        console.time('parse');
        parseUnit(tokens, unit, typemap);
        console.timeEnd('parse');
    } catch(err) {
        if (tokens) {
            addproblem(tokens, ParseProblem.Error(tokens.current, `Parse failed: ${err.message}`));
        } else {
            console.log(`Parse failed: ${err.message}`);
        }
    }

    return unit;
}

/**
 * @param {TokenList} tokens
 * @param {SourceUnit} unit
 * @param {Map<string,JavaType>} typemap 
 */
function parseUnit(tokens, unit, typemap) {
    let package_name = '';
    // init resolved imports with java.lang.*
    let resolved_imports = resolveImports(typemap, [], [], null).resolved.slice();
    // retrieve the implicit imports
    while (tokens.current) {
        let modifiers = [], annotations = [];
        for (;tokens.current;) {
            if (tokens.current.kind === 'modifier') {
                modifiers.push(tokens.current);
                tokens.inc();
                continue;
            }
            if (tokens.current.value === '@') {
                tokens.inc().value === 'interface'
                    ? sourceType(modifiers, tokens, package_name, '@interface', unit, resolved_imports, typemap)
                    : annotations.push(annotation(tokens, null, unit.imports, typemap));
                continue;
            }
            break;
        }
        if (!tokens.current) {
            break;
        }
        switch (tokens.current.value) {
            case 'package':
                if (unit.package_ !== null) {
                    addproblem(tokens, ParseProblem.Error(tokens.current, `Multiple package declarations`));
                }
                if (modifiers[0]) {
                    addproblem(tokens, ParseProblem.Error(tokens.current, `Unexpected modifier: ${modifiers[0].source}`));
                }
                const pkg = packageDeclaration(tokens);
                if (!package_name) {
                    unit.package_ = pkg;
                    package_name = pkg.name;
                }
                continue;
            case 'import':
                if (modifiers[0]) {
                    addproblem(tokens, ParseProblem.Error(tokens.current, `Unexpected modifier: ${modifiers[0].source}`));
                }
                const imprt = importDeclaration(tokens, typemap);
                unit.imports.push(imprt);
                if (imprt.resolved) {
                    resolved_imports.push(imprt.resolved);
                }
                continue;
        }
        if (tokens.current.kind === 'type-kw') {
            sourceType(modifiers, tokens, package_name, tokens.current.value, unit, resolved_imports, typemap);
            continue;
        }
        addproblem(tokens, ParseProblem.Error(tokens.current, 'Type declaration expected'));
        // skip until something we recognise
        while (tokens.current) {
            if (/@|package|import/.test(tokens.current.value) || /modifier|type-kw/.test(tokens.current.kind)) {
                break;
            }
            tokens.inc();
        }
    }
    return unit;
}

/**
 * @param {TokenList} tokens 
 */
function packageDeclaration(tokens) {
    tokens.mark();
    tokens.expectValue('package');
    const pkg_name_parts = [];
    for (;;) {
        let name = tokens.current;
        if (!tokens.isKind('ident')) {
            name = null;
            addproblem(tokens, ParseProblem.Error(tokens.current, `Package identifier expected`));
        }
        if (name) pkg_name_parts.push(name.value);
        if (tokens.isValue('.')) {
            continue;
        }
        const decl_tokens = tokens.markEnd();
        semicolon(tokens);
        return new SourcePackage(decl_tokens, pkg_name_parts.join('.'));
    }
}

/**
 * @param {TokenList} tokens 
 * @param {Map<string,JavaType>} typemap 
 */
function importDeclaration(tokens, typemap) {
    tokens.mark();
    tokens.expectValue('import');
    const static_token = tokens.getIfValue('static');
    let asterisk_token = null;
    const pkg_name_parts = [];
    for (;;) {
        let name = tokens.current;
        if (!tokens.isKind('ident')) {
            name = null;
            addproblem(tokens, ParseProblem.Error(tokens.current, `Package identifier expected`));
        }
        if (name) {
            pkg_name_parts.push(name);
        }
        if (tokens.isValue('.')) {
            if (!(asterisk_token = tokens.getIfValue('*'))) {
                continue;
            }
        }
        const decl_tokens = tokens.markEnd();
        semicolon(tokens);

        const pkg_name = pkg_name_parts.map(x => x.source).join('.');
        const resolved = resolveSingleImport(typemap, pkg_name, !!static_token, !!asterisk_token, 'import');

        return new SourceImport(decl_tokens, pkg_name_parts, pkg_name, static_token, asterisk_token, resolved);
    }
}

/**
 * @param {MethodDeclarations} mdecls 
 * @param {Local[]} new_locals 
 */
function addLocals(tokens, mdecls, new_locals) {
    for (let local of new_locals) {
        if (mdecls.locals.find(l => l.name === local.name)) {
            addproblem(tokens, ParseProblem.Error(local.decltoken, `Redeclared variable: ${local.name}`));
        }
        mdecls.locals.unshift(local);
    }
}

/**
 * @param {TokenList} tokens 
 * @param {MethodDeclarations} mdecls
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {ResolvedIdent|Local[]|Statement}
 */
function statement(tokens, mdecls, method, imports, typemap) {
    let s, modifiers = [];
    for (;;) {
        switch(tokens.current.kind) {
            case 'modifier':
                modifiers.push(tokens.current);
                tokens.inc();
                continue;
            case 'type-kw':
                sourceType(modifiers.splice(0,1e9), tokens, method, tokens.current.value, mdecls, imports, typemap);
                continue;
        }
        break;
    }
    // modifiers are only allowed on local variable decls
    if (modifiers.length) {
        s = var_decl(modifiers, tokens, mdecls, method, imports, typemap);
        addLocals(tokens, mdecls, s);
        semicolon(tokens);
        return s;
    }

    switch(tokens.current.kind) {
        case 'statement-kw':
            s = statementKeyword(tokens, mdecls, method, imports, typemap);
            return s;
        case 'ident':
            // checking every statement identifier for a possible label is really inefficient, but trying to
            // merge this into expression_or_var_decl is worse for now
            if (tokens.peek(1).value === ':') {
                const label = new Label(tokens.current);
                tokens.inc(), tokens.inc();
                // ignore and just return the next statement
                // - we cannot return the label as a statement because for/if/while check the next statement type
                // the labels should be collated and checked for duplicates, etc
                return statement(tokens, mdecls, method, imports, typemap);
            }
            // fall-through to expression_or_var_decl
        case 'primitive-type':
            s = expression_or_var_decl(tokens, mdecls, method, imports, typemap);
            if (Array.isArray(s)) {
                addLocals(tokens, mdecls, s);
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
            s = expression(tokens, mdecls, method, imports, typemap);
            semicolon(tokens);
            return s;
    }
    switch(tokens.current.value) {
        case ';':
            tokens.inc();
            return new EmptyStatement();
        case '{':
            return statementBlock(tokens, mdecls, method, imports, typemap);
        case '}':
            return new EmptyStatement();
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
class BreakStatement extends Statement {
    /** @type {Token} */
    target = null;
}
class ContinueStatement extends Statement {
    /** @type {Token} */
    target = null;
}
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
    message = null;
}

/**
* @param {Token[]} modifiers
* @param {TokenList} tokens 
* @param {Scope|string} scope_or_pkgname
* @param {string} typeKind
* @param {{types:SourceType[]}} owner
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function sourceType(modifiers, tokens, scope_or_pkgname, typeKind, owner, imports, typemap) {
    let package_name, scope;
    if (typeof scope_or_pkgname === 'string') {
        package_name = scope_or_pkgname;
        scope = null;
    } else {
        const scoped_type = scope_or_pkgname instanceof SourceType ? scope_or_pkgname : scope_or_pkgname.owner;
        package_name = scoped_type.packageName;
        scope = scope_or_pkgname;
    }
    const type = typeDeclaration(package_name, scope, modifiers, typeKind, tokens.current, tokens, imports, typemap);
    owner.types.push(type);
    if (!(owner instanceof MethodDeclarations)) {
        typemap.set(type.shortSignature, type);
    }
    if (tokens.isValue('extends')) {
        type.extends_types = typeIdentList(tokens, type, imports, typemap);
    }
    if (tokens.isValue('implements')) {
        type.implements_types = typeIdentList(tokens, type, imports, typemap);
    }
    tokens.expectValue('{');
    if (!tokens.isValue('}')) {
        typeBody(type, tokens, owner, imports, typemap);
        tokens.expectValue('}');
    }
}

/**
* @param {SourceType} type 
* @param {TokenList} tokens 
* @param {{types:SourceType[]}} owner
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function typeBody(type, tokens, owner, imports, typemap) {
    for (;;) {
        let modifiers = [], annotations = [];
        while (tokens.current.kind === 'modifier') {
            modifiers.push(tokens.current);
            tokens.inc();
        }
        switch(tokens.current.kind) {
            case 'ident':
            case 'primitive-type':
                fmc(modifiers, annotations, [], type, tokens, imports, typemap);
                continue;
            case 'type-kw':
                sourceType(modifiers, tokens, type, tokens.current.value, owner, imports, typemap);
                continue;
        }
        switch(tokens.current.value) {
            case '<':
                const type_variables = typeVariableList(type, tokens, type, imports, typemap);
                fmc(modifiers, annotations, type_variables, type, tokens, imports, typemap);
                continue;
            case '@':
                tokens.inc().value === 'interface' 
                    ? sourceType(modifiers, tokens, type, '@interface', owner, imports, typemap)
                    : annotation(tokens, type, imports, typemap);
                continue;
            case ';':
                tokens.inc();
                continue;
            case '{':
                initer(tokens, type, modifiers.splice(0,1e9));
                continue;
            case '}':
                return;
        }
        if (!tokens.inc()) {
            break;
        }
    }
}

/**
 * @param {Token[]} modifiers 
 * @param {SourceAnnotation[]} annotations 
 * @param {TypeVariable[]} type_vars
 * @param {SourceType} type 
 * @param {TokenList} tokens 
 * @param {ResolvedImport[]} imports 
 * @param {Map<string,JavaType>} typemap 
 */
function fmc(modifiers, annotations, type_vars, type, tokens, imports, typemap) {
    let decl_type_ident = typeIdent(tokens, type, imports, typemap, { no_array_qualifiers: false, type_vars });
    if (decl_type_ident.resolved.rawTypeSignature === type.rawTypeSignature) {
        if (tokens.current.value === '(') {
            // constructor
            const { parameters, throws, body } = methodDeclaration(type_vars, type, tokens, imports, typemap);
            const ctr = new SourceConstructor(type, type_vars, modifiers, parameters, throws, body);
            type.constructors.push(ctr);
            return;
        }
    }
    let name = tokens.current;
    if (!tokens.isKind('ident')) {
        name = null;
        addproblem(tokens, ParseProblem.Error(tokens.current, `Identifier expected`))
    }
    if (tokens.current.value === '(') {
        const { postnamearrdims, parameters, throws, body } = methodDeclaration(type_vars, type, tokens, imports, typemap);
        if (postnamearrdims > 0) {
            decl_type_ident.resolved = new ArrayType(decl_type_ident.resolved, postnamearrdims);
        }
        const method = new SourceMethod(type, type_vars, modifiers, annotations, decl_type_ident, name, parameters, throws, body);
        type.methods.push(method);
    } else {
        if (name) {
            if (type_vars.length) {
                addproblem(tokens, ParseProblem.Error(tokens.current, `Fields cannot declare type variables`));
            }
            const locals = var_ident_list(modifiers, decl_type_ident, name, tokens, new MethodDeclarations(), type, imports, typemap);
            const fields = locals.map(l => new SourceField(type, modifiers, l.typeIdent, l.decltoken));
            type.fields.push(...fields);
        }
        semicolon(tokens);
    }
}

/**
 * 
 * @param {TokenList} tokens 
 * @param {SourceType} type 
 * @param {Token[]} modifiers 
 */
function initer(tokens, type, modifiers) {
    const i = new SourceInitialiser(type, modifiers, skipBody(tokens));
    type.initers.push(i);
}

/**
 * 
 * @param {TokenList} tokens 
 */
function skipBody(tokens) {
    let body = null;
    const start_idx = tokens.idx;
    if (tokens.expectValue('{')) {
        // skip the method body
        for (let balance=1; balance;) {
            switch (tokens.current.value) {
                case '{': balance++; break;
                case '}': {
                    if (--balance === 0) {
                        body = tokens.tokens.slice(start_idx, tokens.idx + 1);
                    }
                    break;
                }
            }
            tokens.inc();
        }
    }
    return body;
}

/**
 * 
 * @param {TokenList} tokens 
 */
function annotation(tokens, scope, imports, typemap) {
    if (tokens.current.kind !== 'ident') {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Type identifier expected`));
        return;
    }
    let annotation_type = typeIdent(tokens, scope, imports, typemap, {no_array_qualifiers: true, type_vars:[]});
    if (tokens.isValue('(')) {
        if (!tokens.isValue(')')) {
            expressionList(tokens, new MethodDeclarations(), scope, imports, typemap);
            tokens.expectValue(')');
        }
    }
    return new SourceAnnotation(annotation_type);
}
    
/**
 * @param {string} package_name
 * @param {Scope} scope
 * @param {Token[]} modifiers
 * @param {string} typeKind
 * @param {Token} kind_token
 * @param {TokenList} tokens 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap
 */
function typeDeclaration(package_name, scope, modifiers, typeKind, kind_token, tokens, imports, typemap) {
    let name = tokens.inc();
    if (!tokens.isKind('ident')) {
        name = null;
        addproblem(tokens, ParseProblem.Error(tokens.current, `Type identifier expected`));
        return;
    }
    const type_short_sig = SourceType.getShortSignature(package_name, scope, name.value);
    // the source type object should already exist in the type map
    /** @type {SourceType} */
    // @ts-ignore
    let type = typemap.get(type_short_sig);
    if (type instanceof SourceType) {
        // update the missing parts
        type.setModifierTokens(modifiers);
    } else {
        type = new SourceType(package_name, scope, '', modifiers, typeKind, kind_token, name, typemap);
    }
    type.typeVariables = tokens.current.value === '<'
        ? typeVariableList(type, tokens, scope, imports, typemap)
        : [];

    return type;
}

/**
 * @param {CEIType} owner
 * @param {TokenList} tokens 
 * @param {Scope} scope
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap
 */
function typeVariableList(owner, tokens, scope, imports, typemap) {
    tokens.expectValue('<');
    /** @type {TypeVariable[]} */
    const type_variables = [];
    for (;;) {
        let name = tokens.current, bounds = [];
        if (!tokens.isKind('ident')) {
            name = null;
            addproblem(tokens, ParseProblem.Error(tokens.current, `Type identifier expected`));
        }
        switch (tokens.current.value) {
            case 'extends':
            case 'super':
                tokens.inc();
                const {resolved: type_bounds} = typeIdent(tokens, scope, imports, typemap);
                bounds.push(new TypeVariable.Bound(owner, type_bounds.typeSignature, type_bounds.typeKind === 'interface'));
                break;
        }
        if (name) {
            type_variables.push(new TypeVariable(owner, name.value, bounds));
            if (tokens.isValue(',')) {
                continue;
            }
        }
        if (tokens.current.kind === 'ident') {
            addproblem(tokens, ParseProblem.Error(tokens.current, `Missing comma`));
            continue;
        }
        tokens.expectValue('>');
        break;
    }
    return type_variables;
}


/**
 * @param {TypeVariable[]} type_vars
 * @param {SourceType} owner 
 * @param {TokenList} tokens 
 * @param {ResolvedImport[]} imports 
 * @param {Map<string,JavaType>} typemap 
 */
function methodDeclaration(type_vars, owner, tokens, imports, typemap) {
    tokens.expectValue('(');
    let parameters = [], throws = [], postnamearrdims = 0, body = null;
    if (!tokens.isValue(')')) {
        for(;;) {
            const p = parameterDeclaration(type_vars, owner, tokens, imports, typemap);
            parameters.push(p);
            if (tokens.isValue(',')) {
                continue;
            }
            tokens.expectValue(')');
            break;
        }
    }
    while (tokens.isValue('[')) {
        postnamearrdims += 1;
        tokens.expectValue(']');
    }
    if (tokens.isValue('throws')) {
        throws = typeIdentList(tokens, owner, imports, typemap);
    }
    if (!tokens.isValue(';')) {
        body = skipBody(tokens);
    }
    return {
        postnamearrdims,
        parameters,
        throws,
        body,
    }
}

/**
 * @param {TypeVariable[]} type_vars 
 * @param {SourceType} owner 
 * @param {TokenList} tokens 
 * @param {ResolvedImport[]} imports 
 * @param {Map<string,JavaType>} typemap 
 */
function parameterDeclaration(type_vars, owner, tokens, imports, typemap) {
    const modifiers = [];
    while (tokens.current.kind === 'modifier') {
        modifiers.push(tokens.current);
        tokens.inc();
    }
    checkLocalModifiers(tokens, modifiers);
    let type_ident = typeIdent(tokens, owner, imports, typemap, { no_array_qualifiers: false, type_vars });
    const varargs = tokens.isValue('...');
    let name_token = tokens.current;
    if (!tokens.isKind('ident')) {
        name_token = null;
        addproblem(tokens, ParseProblem.Error(tokens.current, `Identifier expected`))
    }
    let postnamearrdims = 0;
    while (tokens.isValue('[')) {
        postnamearrdims += 1;
        tokens.expectValue(']');
    }
    if (postnamearrdims > 0) {
        type_ident.resolved = new ArrayType(type_ident.resolved, postnamearrdims);
    }
    if (varargs) {
        type_ident.resolved = new ArrayType(type_ident.resolved, 1);
    }
    return new SourceParameter(modifiers, type_ident, varargs, name_token);
}

/**
 * @param {TokenList} tokens 
 * @param {MethodDeclarations} mdecls
 * @param {SourceMC} method 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function statementBlock(tokens, mdecls, method, imports, typemap) {
    const b = new Block();
    tokens.expectValue('{');
    mdecls.pushScope();
    while (!tokens.isValue('}')) {
        const s = statement(tokens, mdecls, method, imports, typemap);
        b.statements.push(s);
    }
    mdecls.popScope();
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
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function statementKeyword(tokens, mdecls, method, imports, typemap) {
    let s;
    switch (tokens.current.value) {
        case 'if':
            tokens.inc();
            s = new IfStatement();
            s.test = bracketedTest(tokens, mdecls, method, imports, typemap);
            s.statement = nonVarDeclStatement(tokens, mdecls, method, imports, typemap);
            if (tokens.isValue('else')) {
                s.elseStatement = nonVarDeclStatement(tokens, mdecls, method, imports, typemap);
            }
            break;
        case 'while':
            tokens.inc();
            s = new WhileStatement();
            s.test = bracketedTest(tokens, mdecls, method, imports, typemap);
            s.statement = nonVarDeclStatement(tokens, mdecls, method, imports, typemap);
            break;
        case 'break':
            tokens.inc();
            s = new BreakStatement();
            if (tokens.current.kind === 'ident') {
                s.target = tokens.current;
                tokens.inc();
            }
            semicolon(tokens);
            break;
        case 'continue':
            tokens.inc();
            s = new ContinueStatement();
            if (tokens.current.kind === 'ident') {
                s.target = tokens.current;
                tokens.inc();
            }
            semicolon(tokens);
            break;
        case 'switch':
            tokens.inc();
            s = new SwitchStatement();
            switchBlock(s, tokens, mdecls, method, imports, typemap);
            break;
        case 'do':
            tokens.inc();
            s = new DoStatement();
            s.block = statementBlock(tokens, mdecls, method, imports, typemap);
            tokens.expectValue('while');
            s.test = bracketedTest(tokens, mdecls, method, imports, typemap);
            semicolon(tokens);
            break;
        case 'try':
            tokens.inc();
            s = new TryStatement();
            s.block = statementBlock(tokens, mdecls, method, imports, typemap);
            catchFinallyBlocks(s, tokens, mdecls, method, imports, typemap);
            break;
        case 'return':
            tokens.inc();
            s = new ReturnStatement();
            s.expression = isExpressionStart(tokens.current) ? expression(tokens, mdecls, method, imports, typemap) : null;
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
                s.expression = isExpressionStart(tokens.current) ? expression(tokens, mdecls, method, imports, typemap) : null;
                checkThrowExpression(tokens, s.expression, typemap);
                semicolon(tokens);
            }
            break;
        case 'for':
            tokens.inc();
            s = new ForStatement();
            mdecls.pushScope();
            forStatement(s, tokens, mdecls, method, imports, typemap);
            mdecls.popScope();
            break;
        case 'synchronized':
            tokens.inc();
            s = new SynchronizedStatement();
            synchronizedStatement(s, tokens, mdecls, method, imports, typemap);
            break;
        case 'assert':
            tokens.inc();
            s = new AssertStatement();
            assertStatement(s, tokens, mdecls, method, imports, typemap);
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
* @param {MethodDeclarations} mdecls
* @param {Scope} scope 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function bracketedTest(tokens, mdecls, scope, imports, typemap) {
    tokens.expectValue('(');
    const e = expression(tokens, mdecls, scope, imports, typemap);
    if (e.variables[0] && !isTypeAssignable(PrimitiveType.map.Z, e.variables[0].type)) {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Boolean expression expected, but type '${e.variables[0].type.fullyDottedTypeName}' found`));
    }
    tokens.expectValue(')');
    return e;
}

/**
* @param {TokenList} tokens 
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function nonVarDeclStatement(tokens, mdecls, method, imports, typemap) {
    const s = statement(tokens, mdecls, method, imports, typemap);
    if (Array.isArray(s)) {
        addproblem(tokens, ParseProblem.Error(tokens.previous, `Variable declarations are not permitted as a single conditional statement.`));
    }
    return s;
}

/**
* @param {ForStatement} s
* @param {TokenList} tokens 
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function forStatement(s, tokens, mdecls, method, imports, typemap) {
    tokens.expectValue('(');
    if (!tokens.isValue(';')) {
        s.init = expression_list_or_var_decl(tokens, mdecls, method, imports, typemap);
        // s.init is always an array, so we need to check the element type
        if (s.init[0] instanceof Local) {
            // @ts-ignore
            addLocals(tokens, mdecls, s.init);
        }
        if (tokens.current.value === ':') {
            enhancedFor(s, tokens, mdecls, method, imports, typemap);
            return;
        }
        semicolon(tokens);
    }
    // for-condition
    if (!tokens.isValue(';')) {
        s.test = expression(tokens, mdecls, method, imports, typemap);
        semicolon(tokens);
    }
    // for-updated
    if (!tokens.isValue(')')) {
        s.update = expressionList(tokens, mdecls, method, imports, typemap);
        tokens.expectValue(')');
    }
    s.statement = nonVarDeclStatement(tokens, mdecls, method, imports, typemap);
}

/**
* @param {ForStatement} s
* @param {TokenList} tokens 
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function enhancedFor(s, tokens, mdecls, method, imports, typemap) {
    const colon = tokens.current;
    tokens.inc();
    // enhanced for
    const iter_var = s.init[0];
    if (!(iter_var instanceof Local)) {
        addproblem(tokens, ParseProblem.Error(tokens.previous, `For iterator must be a single variable declaration`));
    }
    s.iterable = expression(tokens, mdecls, method, imports, typemap);
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
    s.statement = nonVarDeclStatement(tokens, mdecls, method, imports, typemap);
}

/**
* @param {SynchronizedStatement} s
* @param {TokenList} tokens 
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function synchronizedStatement(s, tokens, mdecls, method, imports, typemap) {
    tokens.expectValue('(');
    s.expression = expression(tokens, mdecls, method, imports, typemap);
    if (s.expression.variables[0]) {
        if (s.expression.variables[0].type instanceof PrimitiveType) {
            addproblem(tokens, ParseProblem.Error(tokens.current, `synchronized lock expression must be a reference type`));
        }
    }
    tokens.expectValue(')');
    s.statement = nonVarDeclStatement(tokens, mdecls, method, imports, typemap);
}

/**
* @param {AssertStatement} s
* @param {TokenList} tokens 
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function assertStatement(s, tokens, mdecls, method, imports, typemap) {
    s.expression = expression(tokens, mdecls, method, imports, typemap);
    if (s.expression.variables[0] && !isAssignable(PrimitiveType.map.Z, s.expression.variables[0])) {
        addproblem(tokens, ParseProblem.Error(tokens.current, `Boolean expression expected but type '${s.expression.variables[0].type.fullyDottedTypeName}' found`));
    }

    if (tokens.isValue(':')) {
        s.message = expression(tokens, mdecls, method, imports, typemap);
        if (s.message.variables[0] && (s.message.variables[0].type === PrimitiveType.map.V)) {
            addproblem(tokens, ParseProblem.Error(tokens.current, `assert message expression cannot be void`));
        }
    }
}

/**
* @param {TryStatement} s
* @param {TokenList} tokens 
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function catchFinallyBlocks(s, tokens, mdecls, method, imports, typemap) {
    for (;;) {
        if (tokens.isValue('finally')) {
            if (s.catches.find(c => c instanceof Block)) {
                addproblem(tokens, ParseProblem.Error(tokens.current, `Multiple finally blocks are not permitted`));
            }
            s.catches.push(statementBlock(tokens, mdecls, method, imports, typemap));
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
            let t = catchType(tokens, mdecls, method, imports, typemap);
            if (t) catchinfo.types.push(t);
            while (tokens.isValue('|')) {
                let t = catchType(tokens, mdecls, method, imports, typemap);
                if (t) catchinfo.types.push(t);
            }
            if (tokens.current.kind === 'ident') {
                catchinfo.name = tokens.current;
                tokens.inc();
            } else {
                addproblem(tokens, ParseProblem.Error(tokens.current, `Variable identifier expected`));
            }
            tokens.expectValue(')');
            mdecls.pushScope();
            let exceptionVar;
            if (catchinfo.types[0] && catchinfo.name) {
                checkLocalModifiers(tokens, mods);
                exceptionVar = new Local(mods, catchinfo.name.value, catchinfo.name, catchinfo.types[0], 0);
                mdecls.locals.push(exceptionVar);
            }
            catchinfo.block = statementBlock(tokens, mdecls, method, imports, typemap);
            s.catches.push(catchinfo);
            mdecls.popScope();
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
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function catchType(tokens, mdecls, method, imports, typemap) {
    const t = qualifiedTerm(tokens, mdecls, method, imports, typemap);
    if (t.types[0]) {
        return t.types[0];
    }
    addproblem(tokens, ParseProblem.Error(tokens.current, `Missing or invalid type`));
    return new UnresolvedType(t.source);
}
    
/**
* @param {SwitchStatement} s
* @param {TokenList} tokens 
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function switchBlock(s, tokens, mdecls, method, imports, typemap) {
    tokens.expectValue('(');
    s.test = expression(tokens, mdecls, method, imports, typemap);
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
            caseBlock(s, test_type, tokens, mdecls, method, imports, typemap);
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
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function caseBlock(s, test_type, tokens, mdecls, method, imports, typemap) {
    const case_start_idx = s.cases.length;
    caseExpressionList(s.cases, test_type, tokens, mdecls, method, imports, typemap);
    const statements = [];
    for (;;) {
        if (/^(case|default|\})$/.test(tokens.current.value)) {
            break;
        }
        const s = statement(tokens, mdecls, method, imports, typemap);
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
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function caseExpressionList(cases, test_type, tokens, mdecls, method, imports, typemap) {
    let c = caseExpression(cases, test_type, tokens, mdecls, method, imports, typemap);
    if (!c) {
        return;
    }
    while (c) {
        cases.push(c);
        c = caseExpression(cases, test_type, tokens, mdecls, method, imports, typemap);
    }
}

/**
* @param {(ResolvedIdent|boolean)[]} cases
* @param {JavaType} test_type
* @param {TokenList} tokens 
* @param {MethodDeclarations} mdecls
* @param {SourceMC} method 
* @param {ResolvedImport[]} imports
* @param {Map<string,JavaType>} typemap 
*/
function caseExpression(cases, test_type, tokens, mdecls, method, imports, typemap) {
    /** @type {boolean|ResolvedIdent} */
    let e = tokens.isValue('default');
    if (e && cases.find(c => c === e)) {
        addproblem(tokens, ParseProblem.Error(tokens.previous, `Duplicate case: default`))
    }
    if (!e) {
        if (tokens.isValue('case')) {
            e = expression(tokens, mdecls, method, imports, typemap);
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
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {Local[]}
 */
function var_decl(mods, tokens, mdecls, scope, imports, typemap) {
    const type = typeIdent(tokens, scope, imports, typemap);
    return var_ident_list(mods, type, null, tokens, mdecls, scope, imports, typemap)
}

/**
 * 
 * @param {Token[]} mods 
 * @param {SourceTypeIdent} type 
 * @param {Token} first_ident 
 * @param {TokenList} tokens 
 * @param {MethodDeclarations} mdecls 
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports 
 * @param {Map<string,JavaType>} typemap 
 */
function var_ident_list(mods, type, first_ident, tokens, mdecls, scope, imports, typemap) {
    checkLocalModifiers(tokens, mods);
    const new_locals = [];
    for (;;) {
        let name;
        if (first_ident && !new_locals[0]) {
            name = first_ident;
        } else {
            name = tokens.current;
            if (!tokens.isKind('ident')) {
                name = null;
                addproblem(tokens, ParseProblem.Error(tokens.current, `Variable name expected`));
            }
        }
        // look for [] after the variable name
        let postnamearrdims = 0;
        while (tokens.isValue('[')) {
            postnamearrdims += 1;
            tokens.expectValue(']');
        }
        let init = null, op = tokens.current;
        if (tokens.isValue('=')) {
            init = expression(tokens, mdecls, scope, imports, typemap);
        }
        // only add the local if we have a name
        if (name) {
            const local = new Local(mods, name.value, name, type, postnamearrdims);
            local.init = init;
            if (init && init.variables[0])
                checkAssignmentExpression(tokens, local, op, init.variables[0]);
            new_locals.push(local);
        }
        if (tokens.isValue(',')) {
            continue;
        }
        break;
    }
    return new_locals;
}
    
/**
 * @param {TokenList} tokens 
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {ResolvedIdent|Local[]}
 */
function expression_or_var_decl(tokens, mdecls, scope, imports, typemap) {

    /** @type {ResolvedIdent} */
    let matches = expression(tokens, mdecls, scope, imports, typemap);

    // if theres at least one type followed by an ident, we assume a variable declaration
    if (matches.types[0] && tokens.current.kind === 'ident') {
        return var_ident_list([], new SourceTypeIdent(matches.tokens, matches.types[0]), null, tokens, mdecls, scope, imports, typemap);
    }

    return matches;
}

/**
 * @param {TokenList} tokens 
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {ResolvedIdent[]|Local[]}
 */
function expression_list_or_var_decl(tokens, mdecls, scope, imports, typemap) {
    let e = expression_or_var_decl(tokens, mdecls, scope, imports, typemap);
    if (Array.isArray(e)) {
        // local var decl
        return e;
    }
    const expressions = [e];
    while (tokens.isValue(',')) {
        e = expression(tokens, mdecls, scope, imports, typemap);
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
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function expression(tokens, mdecls, scope, imports, typemap, precedence_stack = [13]) {
    tokens.mark();
    /** @type {ResolvedIdent} */
    let matches = qualifiedTerm(tokens, mdecls, scope, imports, typemap);

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
        const rhs = expression(tokens, mdecls, scope, imports, typemap, [operator_precedence, ...precedence_stack]);

        if (binary_operator.value === '?') {
            const colon = tokens.current;
            tokens.expectValue(':');
            const falseStatement = expression(tokens, mdecls, scope, imports, typemap, [operator_precedence, ...precedence_stack]);
            matches = resolveTernaryExpression(tokens, matches, colon, rhs, falseStatement);
        } else {
            matches = resolveBinaryOpExpression(tokens, matches, binary_operator, rhs);
        }
    }

    matches.tokens = tokens.markEnd();
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
    const is_assignable = isAssignable(variable.type, value);
    if (!is_assignable) {
        if (value instanceof ArrayLiteral) {
            addproblem(tokens, ParseProblem.Error(op, `Array literal expression is not compatible with variable of type '${variable.type.fullyDottedTypeName}'`));
        } else {
            addproblem(tokens, ParseProblem.Error(op, `Incompatible types: Expression of type '${value.type.fullyDottedTypeName}' cannot be assigned to a variable of type '${variable.type.fullyDottedTypeName}'`));
        }
    }

    if (value instanceof TernaryValue) {
        checkAssignmentExpression(tokens, variable, value.colon, value.falseValue);
    }
}

/**
 * @param {JavaType} variable_type 
 * @param {ArrayLiteral} arr_literal_value 
 */
function isArrayAssignable(variable_type, arr_literal_value) {
    if (!(variable_type instanceof ArrayType)) {
        return false;
    }
    // empty array literals are compatible with all arrays
    if (arr_literal_value.elements.length === 0) {
        return true;
    }
    const required_element_type = variable_type.elementType;
    for (let i=0; i < arr_literal_value.elements.length; i++) {
        const element_value = arr_literal_value.elements[i].variables[0];
        let is_assignable = !!element_value && isAssignable(required_element_type, element_value);
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
    if (value instanceof ArrayLiteral) {
        return isArrayAssignable(type, value);
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
    if (value_typevar_type instanceof TypeVariableType) {
        // inferred type arguments of the form `x = List<>` are compatible with every destination type variable
        return value_typevar_type.typeVariable instanceof InferredTypeArgument;
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
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function qualifiedTerm(tokens, mdecls, scope, imports, typemap) {
    let matches = rootTerm(tokens, mdecls, scope, imports, typemap);
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
    matches = qualifiers(matches, tokens, mdecls, scope, imports, typemap);
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
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 * @returns {ResolvedIdent}
 */
function rootTerm(tokens, mdecls, scope, imports, typemap) {
    /** @type {ResolvedIdent} */
    let matches;
    switch(tokens.current.kind) {
        case 'ident':
            matches = resolveIdentifier(tokens, mdecls, scope, imports, typemap);
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
            const scoped_type = scope instanceof SourceType ? scope : scope.owner;
            if (tokens.current.value === 'this') {
                matches = new ResolvedIdent(tokens.current.value, [new Value(tokens.current.value, scoped_type)]);
            } else if (tokens.current.value === 'super') {
                const supertype = scoped_type.supers.find(s => s.typeKind === 'class') || typemap.get('java/lang/Object');
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
            matches = qualifiedTerm(tokens, mdecls, scope, imports, typemap);
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
            return qualifiedTerm(tokens, mdecls, scope, imports, typemap);
        case 'new-operator':
            return newTerm(tokens, mdecls, scope, imports, typemap);
        case 'open-bracket':
            tokens.inc();
            matches = expression(tokens, mdecls, scope, imports, typemap);
            const close_bracket = tokens.current;
            tokens.expectValue(')');
            if (isCastExpression(tokens.current, matches)) {
                // typecast
                const type = matches.types[0];
                if (!type) {
                    addproblem(tokens, ParseProblem.Error(close_bracket, 'Type expected'));
                }
                const cast_matches = qualifiedTerm(tokens, mdecls, scope, imports, typemap)
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
                elements = expressionList(tokens, mdecls, scope, imports, typemap);
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
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function newTerm(tokens, mdecls, scope, imports, typemap) {
    tokens.expectValue('new');
    const type_start_token = tokens.idx;
    const { resolved: ctr_type } = typeIdent(tokens, scope, imports, typemap, {no_array_qualifiers:true, type_vars:[]});
    if (ctr_type instanceof AnyType) {
        const toks = tokens.tokens.slice(type_start_token, tokens.idx);
        addproblem(tokens, ParseProblem.Error(toks, `Unresolved type: '${toks.map(t => t.source).join('')}'`));
    }
    let match = new ResolvedIdent(`new ${ctr_type.simpleTypeName}`, [], [], [ctr_type]);
    switch(tokens.current.value) {
        case '[':
            match = arrayQualifiers(match, tokens, mdecls, scope, imports, typemap);
            // @ts-ignore
            if (tokens.current.value === '{') {
                // array init
                rootTerm(tokens, mdecls, scope, imports, typemap);
            }
            return new ResolvedIdent(match.source, [new Value(match.source, match.types[0])]);
        case '(':
            match = methodCallQualifier(match, tokens, mdecls, scope, imports, typemap);
            // @ts-ignore
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
            return match;
    }

    addproblem(tokens, ParseProblem.Error(tokens.current, 'Constructor expression expected'));
    return new ResolvedIdent(match.source, [new Value(match.source, ctr_type)]);
}

/**
 * @param {TokenList} tokens 
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function expressionList(tokens, mdecls, scope, imports, typemap) {
    let e = expression(tokens, mdecls, scope, imports, typemap);
    const expressions = [e];
    while (tokens.current.value === ',') {
        tokens.inc();
        e = expression(tokens, mdecls, scope, imports, typemap);
        expressions.push(e);
    }
    return expressions;
}

/**
 * @param {TokenList} tokens 
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function arrayIndexOrDimension(tokens, mdecls, scope, imports, typemap) {
    let e = expression(tokens, mdecls, scope, imports, typemap);
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

    const types = matches.types.map(t => new ArrayType(t, 1));

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
            if (!(instance.methods[0] instanceof AnyMethod)) {
                const methodlist = instance.methods.map(m => m.label).join('\n-  ');
                addproblem(tokens, ParseProblem.Error(tokens.current,
                    `No compatible method found. Tried to match:\n-  ${methodlist}\nagainst call argument types: (${callargtypes})`))
            }
            // fake a result with AnyMethod
            methods.push(new AnyMethod(instance.source));
        } else if (instance.types[0]) {
            if (!(instance.types[0] instanceof AnyType)) {
                const ctrlist = instance.types[0].constructors.map(c => c.label).join('\n-  ');
                const match_message = instance.types[0].constructors.length
                    ? `Tried to match:\n-  ${ctrlist}\nagainst call argument types: (${callargtypes})`
                    : 'The type has no accessible constructors';
                addproblem(tokens, ParseProblem.Error(tokens.current, 
                    `No compatible constructor found for type '${instance.types[0].fullyDottedTypeName}'. ${match_message}`));
            }
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
    const param_count = m.parameterCount;
    if (param_count !== call_arguments.length) {
        // for variable arity methods, we must have at least n-1 formal parameters
        if (!m.isVariableArity || call_arguments.length < param_count - 1) {
            // wrong parameter count
            return false;
        }
    }
    const formal_params = m.parameters.slice();
    const last_param = formal_params.pop();
    for (let i = 0; i < call_arguments.length; i++) {
        if (!call_arguments[i].variables[0]) {
            // only variables can be passed - not types or methods
            return false;
        }
        const param = formal_params[i] || last_param;
        let param_type = param.type;
        if (param.varargs && param_type instanceof ArrayType) {
            // last varargs parameter
            // - if the argument count matches the parameter count, the final argument can match the array or non-array version
            // e.g void v(int... x) will match with v(), v(1) and v(new int[3]);
            if (call_arguments.length === param_count) {
                if (isAssignable(param_type, call_arguments[i].variables[0])) {
                    continue;
                }
            }
            param_type = param_type.elementType;
        }
        // is the argument assignable to the parameter
        if (isAssignable(param_type, call_arguments[i].variables[0])) {
            continue;
        }
        // mismatch parameter type
        return false;
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
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function qualifiers(matches, tokens, mdecls, scope, imports, typemap) {
    for (;;) {
        switch (tokens.current.value) {
            case '.':
                matches = dottedIdent(matches, tokens, typemap);
                break;
            case '[':
                matches = arrayQualifiers(matches, tokens, mdecls, scope, imports, typemap);
                break;
            case '(':
                // method or constructor call
                matches = methodCallQualifier(matches, tokens, mdecls, scope, imports, typemap);
                break;
            case '<':
                // generic type arguments - since this can be confused with less-than, only parse
                // it if there is at least one type and no matching variables
                if (!matches.types[0] || matches.variables[0]) {
                    return matches;
                }
                tokens.inc();
                genericTypeArgs(tokens, matches.types, scope, imports, typemap);
                break;
            default:
                return matches;
        }
    }
}

/**
 * @param {ResolvedIdent} matches
 * @param {TokenList} tokens 
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function arrayQualifiers(matches, tokens, mdecls, scope, imports, typemap) {
    while (tokens.isValue('[')) {
        let open_array = tokens.current;
        if (tokens.isValue(']')) {
            // array type
            matches = arrayTypeExpression(matches);
        } else {
            // array index
            const index = arrayIndexOrDimension(tokens, mdecls, scope, imports, typemap);
            matches = arrayElementOrConstructor(tokens, open_array, matches, index);
            // @ts-ignore
            tokens.expectValue(']');
        }
    }
    return matches;
}

/**
 * @param {ResolvedIdent} matches
 * @param {TokenList} tokens 
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function methodCallQualifier(matches, tokens, mdecls, scope, imports, typemap) {
    let args = [];
    tokens.expectValue('(');
    if (!tokens.isValue(')')) {
        args = expressionList(tokens, mdecls, scope, imports, typemap);
        tokens.expectValue(')');
    }
    return methodCallExpression(tokens, matches, args, typemap);
}

/**
 * @param {ResolvedIdent} matches 
 */
function arrayTypeExpression(matches) {
    const types = matches.types.map(t => new ArrayType(t, 1));
    return new ResolvedIdent(`${matches.source}[]`, [], [], types);
}

/**
 * 
 * @param {ResolvedIdent} matches 
 * @param {TokenList} tokens 
 * @param {Map<string,JavaType>} typemap 
 */
function dottedIdent(matches, tokens, typemap) {
    tokens.expectValue('.');
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
 * @param {MethodDeclarations} mdecls
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports
 * @param {Map<string,JavaType>} typemap 
 */
function resolveIdentifier(tokens, mdecls, scope, imports, typemap) {
    const ident = tokens.current.value;
    const matches = findIdentifier(ident, mdecls, scope, imports, typemap);
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
 * @param {MethodDeclarations} mdecls 
 * @param {Scope} scope 
 * @param {ResolvedImport[]} imports 
 * @param {Map<String,JavaType>} typemap 
 */
function findIdentifier(ident, mdecls, scope, imports, typemap) {
    const matches = new ResolvedIdent(ident);

    // is it a local or parameter - note that locals must be ordered innermost-scope-first
    const local = mdecls.locals.find(local => local.name === ident);
    let param = !(scope instanceof SourceType) && scope.parameters.find(p => p.name === ident);
    if (local || param) {
        matches.variables = [local || param];
    } else {
        // is it a field or method in the current type (or any of the superclasses)
        const scoped_type = scope instanceof SourceType ? scope : scope.owner;
        const types = getTypeInheritanceList(scoped_type);
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

    const type = mdecls.types.find(t => t.simpleTypeName === ident);
    if (type) {
        matches.types = [type];
    } else {
        const { types, package_name } = resolveTypeOrPackage(ident, [], scope, imports, typemap);
        matches.types = types;
        matches.package_name = package_name;
    }

    return matches;
}


exports.addproblem = addproblem;
exports.parseBody = parseBody;
exports.parse = parse;
exports.flattenBlocks = flattenBlocks;
