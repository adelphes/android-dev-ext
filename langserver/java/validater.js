const { CEIType } = require('java-mti');
const { resolveImports } = require('../java/import-resolver');
const { SourceUnit } = require('./source-types');
const { parseBody } = require('./body-parser3');

/**
 * @param {SourceUnit} unit 
 * @param {Map<string, CEIType>} typemap
 */
function parseMethodBodies(unit, typemap) {
    const resolved_types = [
        ...resolveImports(typemap, [], [], unit.packageName).resolved,
        ...unit.imports.filter(i => i.resolved).map(i => i.resolved),
    ]
    unit.types.forEach(t => {
        t.initers.forEach(i => {
            i.parsed = parseBody(i, resolved_types, typemap);
        })
        t.constructors.forEach(c => {
            c.parsed = parseBody(c, resolved_types, typemap);
        })
        t.sourceMethods.forEach(m => {
            m.parsed = parseBody(m, resolved_types, typemap);
        })
    })
}

/**
 * @param {SourceUnit} unit 
 * @param {Map<string, CEIType>} androidLibrary
 * @returns {import('./parsetypes/parse-problem')[]}
 */
function validate(unit, androidLibrary) {
    console.time('validation');

    let probs = [];

    const module_validaters = [
        // require('./validation/multiple-package-decls'),
        // require('./validation/unit-decl-order'),
        // require('./validation/duplicate-members'),
        // require('./validation/parse-errors'),
        // require('./validation/modifier-errors'),
        // require('./validation/unresolved-imports'),
        // require('./validation/invalid-types'),
        // require('./validation/bad-extends'),
        // require('./validation/bad-implements'),
        // require('./validation/non-implemented-interfaces'),
        // require('./validation/bad-overrides'),
        // require('./validation/missing-constructor'),
        //require('./validation/expression-compatibility'),
    ];
    let problems = [
        module_validaters.map(v => v(unit.types, unit)),
        ...probs,
    ];
    console.timeEnd('validation');

    function flatten(arr) {
        let res = arr;
        for (;;) {
            const idx = res.findIndex(x => Array.isArray(x));
            if (idx < 0) {
                return res;
            }
            res = [...res.slice(0, idx), ...res[idx], ...res.slice(idx+1)]
        }
    }

    let flattened = flatten(problems).filter(x => x);
    console.log(`Problems: ${flattened.length}`)
    return flattened;
}

module.exports = {
    validate,
    parseMethodBodies,
}
