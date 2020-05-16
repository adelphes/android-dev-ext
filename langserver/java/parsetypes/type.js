const Declaration = require('./declaration');
const ParseProblem = require('./parse-problem');
const ProblemSeverity = require('./problem-severity');
const ResolvedImport = require('../import-resolver').ResolvedImport;
const { resolveTypeIdents } = require('../type-resolver');
const Token = require('./token');

/**
 * @typedef {import('./import')} ImportDeclaration
 * @typedef {import('./fmc')} FMCDeclaration
 * @typedef {import('./modifier')} Modifier
 * @typedef {import('./parameter')} ParameterDeclaration
 * @typedef {import('./typeident')} TypeIdent
 */

/**
 * Represents a single Java type (class, interface, enum or @-interface) declaration
 */
class TypeDeclaration extends Declaration {
    /**
     *
     * @param {TypeDeclaration} owner_type
     * @param {Token} docs
     * @param {Modifier[]} modifiers
     * @param {'class'|'interface'|'enum'|'@interface'} kind
     * @param {Token} name
     */
    constructor(owner_type, docs, modifiers, kind, name) {
        super(owner_type, docs, modifiers);
        this.kind = kind;
        this.name = name;
        /** @type {FMCDeclaration[]} */
        this.declarations = [];
        /** @type {{decl_kw:Token, typelist:TypeIdent[]}[]} */
        this.super_declarations = [];
    }

    /**
     * returns the $-qualified name of this type (excluding package)
     */
    qualifiedName() {
        if (!this.owner_type) {
            // top-level type
            return this.name.text;
        }
        const parts = [];
        for (let t = this; t;) {
            parts.unshift(t.name.text);
            // @ts-ignore
            t = t.owner_type;
        }
        return parts.join('$');
    }

    qualifiedDottedName() {
        return this.qualifiedName().replace(/[$]/g, '.');
    }

    validate() {
        const checkSuperDeclarations = () => {
            const res = {
                extends: [],
                implements: [],
                first: this.super_declarations[0],
            };
            const problems = [];
            this.super_declarations.forEach((sd) => res[sd.decl_kw.text].push(sd));
            for (let i = 1; i < res.extends.length; i++) {
                problems.push(new ParseProblem(res.extends[i].decl_kw, `Types cannot have multiple 'extends' declarations`, ProblemSeverity.Error));
            }
            for (let i = 1; i < res.implements.length; i++) {
                problems.push(new ParseProblem(res.extends[i].decl_kw, `Types cannot have multiple 'implements' declarations`, ProblemSeverity.Error));
            }
            if (res.extends.length > 0 && res.implements.length > 0 && res.first.decl_kw.text !== 'extends') {
                problems.push(new ParseProblem(res.extends[0].decl_kw, `'extends' declaration must appear before 'implements'`, ProblemSeverity.Error));
            }
            if (this.kind === 'class' && res.extends.length === 1 && res.extends[0].typelist.length > 1) {
                problems.push(new ParseProblem(res.extends[0].decl_kw, `Class types cannot extend from multiple super types`, ProblemSeverity.Error));
            }
            return problems;
        };
        const checkDuplicateFieldNames = () => {
            // get list of fields, sorted by name
            const fields = this.declarations
                .filter((d) => d.kind === 'field')
                .slice()
                .sort((a, b) => a.name.text.localeCompare(b.name.text));
            const probs = [];
            let name = '';
            fields.forEach((decl, idx, arr) => {
                const next = arr[idx + 1];
                if ((next && decl.name.text === next.name.text) || decl.name.text === name) {
                    probs.push(new ParseProblem(decl.name, `Duplicate field name: '${decl.name.text}'`, ProblemSeverity.Error));
                }
                name = decl.name.text;
            });
            return probs;
        };
        let problems = [
            ...ParseProblem.checkDuplicateModifiers(this.modifiers),
            ...ParseProblem.checkConflictingModifiers(this.modifiers),
            ...ParseProblem.checkAccessModifiers(this.modifiers, this.kind),
            ...ParseProblem.checkNonKeywordIdents([this.name]),
            ...ParseProblem.checkNonKeywordIdents(this.declarations.map((d) => d.name)),
            ...checkDuplicateFieldNames(),
            ...checkSuperDeclarations(),
            ...this.declarations.reduce((probs, d) => {
                return [...probs, ...d.validate()];
            }, []),
        ];
        return problems;
    }

    /**
     * @param {string} package_name 
     * @param {ResolvedImport[]} imports 
     * @param {Map<string,*>} typemap 
     */
    validateTypes(package_name, imports, typemap) {
        const problems = [];
        const fqtypename = package_name ? `${package_name}.${this.qualifiedName()}` : this.qualifiedName();

        /** @type {TypeIdent[]} */
        let typeidents = [];

        // check extends
        this.super_declarations.filter(sd => sd.decl_kw.text === 'extends').forEach(sd => {
            sd.typelist.forEach(typeident => typeidents.push(typeident));
        })
        const resolved_extends = resolveTypeIdents(typeidents, package_name, imports, typemap);
        resolved_extends.forEach((rt,i) => {
            checkResolvedType(rt, typeidents[i]);
            if (this.kind === 'class' && rt.mtis.length === 1) {
                // class extend type must be a class
                if (rt.mtis[0].typeKind !== 'class') {
                    problems.push(new ParseProblem(typeidents[i].tokens, `Class '${this.name.text}' cannot extend from ${rt.mtis[0].typeKind} '${rt.label}'; the specified type must be a non-final class.`, ProblemSeverity.Error));
                }
                // class extend type cannot be final
                else if (rt.mtis[0].hasModifier('final')) {
                    problems.push(new ParseProblem(typeidents[i].tokens, `Class '${this.name.text}' cannot extend from final class '${rt.mtis[0].fullyDottedRawName}'.`, ProblemSeverity.Error));
                }
            }
        });

        // check implements
        typeidents = [];
        this.super_declarations.filter(sd => sd.decl_kw.text === 'implements').forEach(sd => {
            sd.typelist.forEach(typeident => typeidents.push(typeident));
            if (this.kind !== 'class' && this.kind !== 'enum') {
                problems.push(new ParseProblem(sd.decl_kw, `implements declarations are not permitted for ${this.kind} types`, ProblemSeverity.Error));
            }
        })
        const resolved_implements = resolveTypeIdents(typeidents, package_name, imports, typemap);
        resolved_implements.forEach((rt,i) => {
            checkResolvedType(rt, typeidents[i]);
            if (/class|enum/.test(this.kind) && rt.mtis.length === 1) {
                // class implements types must be interfaces
                if (rt.mtis[0].typeKind !== 'interface') {
                    problems.push(new ParseProblem(typeidents[i].tokens, `Type '${this.name.text}' cannot implement ${rt.mtis[0].typeKind} type '${rt.mtis[0].fullyDottedRawName}'; the specified type must be an interface.`, ProblemSeverity.Error));
                }
                else if (!this.findModifier('abstract')) {
                    // if the class is not abstract, it must implement all the methods in the interface
                    // - we can't check this until the MTI for the class is complete
                    const unimplemented_methods = rt.mtis[0].methods.filter(m => true);
                    unimplemented_methods.forEach(method => {
                        problems.push(new ParseProblem(typeidents[i].tokens, `Type '${this.name.text}' is not abstract and does not implement method '${method.toDeclSource()}' declared in interface '${rt.mtis[0].fullyDottedRawName}'.`, ProblemSeverity.Error));
                    })
                }
            }
        });

        // check field, method-return and parameter types
        typeidents = [];
        this.declarations.forEach((d) => {
            if (d.kind !== 'constructor') {
                typeidents.push(d.type);
            }
            if (d.parameters) {
                d.parameters.forEach((p) => {
                    typeidents.push(p.type);
                });
            }
        });

        const resolved_types = resolveTypeIdents(typeidents, fqtypename, imports, typemap);
        // warn about missing and ambiguous types
        function checkResolvedType(rt, typeident) {
            if (rt.error) {
                problems.push(new ParseProblem(typeident.tokens, rt.error, ProblemSeverity.Error));
                return;
            }
            if (rt.mtis.length === 0) {
                problems.push(new ParseProblem(typeident.tokens, `Type not found: ${rt.label}`, ProblemSeverity.Error));
                return;
            }
            if (rt.mtis.length > 1) {
                const names = rt.mtis.map(mti => mti.fullyDottedRawName).join(`' or '`);
                problems.push(new ParseProblem(typeident.tokens, `Ambiguous type: ${rt.label} - could be '${names}'.`, ProblemSeverity.Error));
                return;
            }
            rt.mtis.forEach(mti => {
                // void arrays are illegal
                if (mti.name.startsWith('void[')) {
                    problems.push(new ParseProblem(typeident.tokens, `primitive void arrays are not a valid type.`, ProblemSeverity.Error));
                }
            })
        }
        resolved_types.forEach((rt,i) => {
            checkResolvedType(rt, typeidents[i]);

            // check any type arguments
            rt.parts.filter(p => p.typeargs).forEach(p => {
                p.typeargs.forEach(typearg => {
                    checkResolvedType(typearg, typeidents[i]);
                    // check type arguments are not primitives (primitive arrays are ok)
                    if (typearg.mtis.length === 1) {
                        if (typearg.mtis[0].typeKind === 'primitive') {
                            problems.push(new ParseProblem(typeidents[i].tokens, `Type arguments cannot be primitive types.`, ProblemSeverity.Error));
                        }
                    }
                })
            });

        });
        return problems;
    }
}

module.exports = TypeDeclaration;
