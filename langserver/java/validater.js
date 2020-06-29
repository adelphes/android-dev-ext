const { CEIType } = require('java-mti');
const { resolveImports } = require('../java/import-resolver');
const { SourceUnit } = require('./source-types');
const { parseTypeMethods } = require('./body-parser');

/**
 * @param {SourceUnit} unit 
 * @param {Map<string, CEIType>} typemap
 */
function parseMethodBodies(unit, typemap) {
    const resolved_types = [
        ...resolveImports(typemap, unit.packageName),
        ...unit.imports.filter(i => i.resolved).map(i => i.resolved),
    ]
    unit.types.forEach(t => parseTypeMethods(t, resolved_types, typemap));
}

/**
 * @param {SourceUnit} unit 
 * @param {Map<string, CEIType>} androidLibrary
 * @returns {import('./parsetypes/parse-problem')[]}
 */
function validate(unit, androidLibrary) {
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
