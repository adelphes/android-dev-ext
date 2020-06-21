/**
 * @typedef {import('./expressiontypes/Expression').Expression} Expression
 * @typedef {import('./anys').ResolvedValue} ResolvedValue
 */
const { JavaType, CEIType, ArrayType, Method } = require('java-mti');
const { Token } = require('./tokenizer');
const { AnyType, MethodType, PackageNameType, TypeIdentType } = require('./anys');
const ParseProblem = require('./parsetypes/parse-problem');


class ResolvedIdent {
    /**
     * @param {string|Token} ident
     * @param {Expression[]} variables
     * @param {Method[]} methods
     * @param {JavaType[]} types
     * @param {string} package_name
     * @param {Token[]} tokens
     */
    constructor(ident, variables = [], methods = [], types = [], package_name = '', tokens = []) {
        this.source = ident instanceof Token ? ident.value : ident;
        this.variables = variables;
        this.methods = methods;
        this.types = types;
        this.package_name = package_name;
        this.tokens = ident instanceof Token ? [ident] : tokens;
    }

    /**
     * @param {ResolveInfo} ri 
     * @returns {ResolvedValue}
     */
    resolveExpression(ri) {
        if (this.variables[0]) {
            return this.variables[0].resolveExpression(ri);
        }
        if (this.methods[0]) {
            return new MethodType(this.methods);
        }
        if (this.types[0]) {
            return new TypeIdentType(this.types[0]);
        }
        if (this.package_name) {
            return new PackageNameType(this.package_name);
        }
        ri.problems.push(ParseProblem.Error(this.tokens, `Unresolved identifier: ${this.source}`));
        return AnyType.Instance;
    }
}

class Local {
    /**
     * @param {Token[]} modifiers 
     * @param {string} name 
     * @param {Token} decltoken 
     * @param {import('./source-types').SourceTypeIdent} typeIdent 
     * @param {number} postnamearrdims 
     * @param {ResolvedIdent} init 
     */
    constructor(modifiers, name, decltoken, typeIdent, postnamearrdims, init) {
        this.finalToken = modifiers.find(m => m.source === 'final') || null;
        this.name = name;
        this.decltoken = decltoken;
        if (postnamearrdims > 0) {
            typeIdent.resolved = new ArrayType(typeIdent.resolved, postnamearrdims);
        }
        this.typeIdent = typeIdent;
        this.init = init;
    }

    get type() {
        return this.typeIdent.resolved;
    }
}

class Label {
    /**
     * @param {Token} token 
     */
    constructor(token) {
        this.name_token = token;
    }
}

class MethodDeclarations {
    /** @type {Local[]} */
    locals = [];
    /** @type {Label[]} */
    labels = [];
    /** @type {import('./source-types').SourceType[]} */
    types = [];

    _scopeStack = [];

    pushScope() {
        this._scopeStack.push([this.locals, this.labels, this.types]);
        this.locals = this.locals.slice();
        this.labels = this.labels.slice();
        this.types = this.types.slice();
    }

    popScope() {
        const prev = {
            locals: this.locals,
            labels: this.labels,
            types: this.types,
        };
        ([this.locals, this.labels, this.types] = this._scopeStack.pop());
        return prev;
    }
}

class ResolveInfo {
    /**
     * @param {Map<string,CEIType>} typemap 
     * @param {*[]} problems
     */
    constructor(typemap, problems) {
        this.typemap = typemap;
        this.problems = problems;
    }
}

class ValidateInfo extends ResolveInfo {
    constructor(typemap, problems, method) {
        super(typemap, problems);
        this.method = method;
        /** @type {('if'|'else'|'for'|'while'|'do'|'switch'|'try'|'synchronized')[]} */
        this.statementStack = [];
    }
}

exports.Label = Label;
exports.Local = Local;
exports.MethodDeclarations = MethodDeclarations;
exports.ResolvedIdent = ResolvedIdent;
exports.ResolveInfo = ResolveInfo;
exports.ValidateInfo = ValidateInfo;
