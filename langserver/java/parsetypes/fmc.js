/**
 * @typedef {import('./modifier')} Modifier
 * @typedef {import('./parameter')} ParameterDeclaration
 * @typedef {import('./token')} Token
 * @typedef {import('./type')} TypeDeclaration
 * @typedef {import('./typeident')} TypeIdent
 */
const Declaration = require('./declaration');
const ParseProblem = require('./parse-problem');
const ProblemSeverity = require('./problem-severity');

/**
 * Field, method or constructor declaration
 */
class FMCDeclaration extends Declaration {
    /**
     * 
     * @param {TypeDeclaration} owner_type 
     * @param {Token} docs 
     * @param {Modifier[]} modifiers 
     * @param {'field'|'method'|'constructor'} kind 
     * @param {Token} name 
     * @param {TypeIdent} type 
     * @param {Token} equals_comma_sc 
     * @param {ParameterDeclaration[]} parameters 
     */
    constructor(owner_type, docs, modifiers, kind, name, type, equals_comma_sc, parameters) {
        super(owner_type, docs, modifiers);
        this.kind = kind;
        this.name = name;
        this.type = type;
        this.equals_comma_sc = equals_comma_sc;
        this.parameters = parameters || [];
    }

    validate() {
        const checkDuplicateParameterNames = () => {
            const done = new Set();
            return this.parameters
                .filter(p => {
                    if (done.has(p.name.text)) {
                        return true;
                    }
                    done.add(p.name.text);
                })
                .map(p =>
                    new ParseProblem(p.name, `Duplicate parameter name: '${p.name.text}'`, ProblemSeverity.Error)
                );
        };
        const checkParameterCommas = () => {
            const last_param_idx = this.parameters.length - 1;
            return this.parameters.map((p, idx) => {
                if ((idx < last_param_idx) && !p.comma) {
                    return new ParseProblem(p.lastToken(), 'Missing comma', ProblemSeverity.Error);
                }
                else if ((idx === last_param_idx) && p.comma) {
                    return ParseProblem.syntaxError(p.comma);
                }
            });
        }
        const checkFieldSemicolon = () => {
            if (this.kind === 'field') {
                if (!this.equals_comma_sc) {
                    return new ParseProblem(this.name, `Missing operator or semicolon`, ProblemSeverity.Error);
                }
            }
            return null;
        }
        const checkVarargsIsLastParameter = () => {
            return this.parameters
                .slice(0, -1)
                .filter(p => p.varargs)
                .map(p =>
                    new ParseProblem(p.varargs, 'A variable arity parameter must be declared last', ProblemSeverity.Error)
                );
        };
        const problems = [
            ...ParseProblem.checkAccessModifiers(this.modifiers, this.kind),
            ...ParseProblem.checkDuplicateModifiers(this.modifiers),
            ...ParseProblem.checkConflictingModifiers(this.modifiers),
            ...checkParameterCommas(),
            ...checkDuplicateParameterNames(),
            ...checkVarargsIsLastParameter(),
            checkFieldSemicolon(),
        ];
        return problems;
    }
}

module.exports = FMCDeclaration;
