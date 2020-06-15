const { JavaType } = require('java-mti');
const { resolveImports } = require('../java/import-resolver');
const { SourceUnit } = require('./source-type');
const { parseBody } = require('./body-parser3');


/**
 * @param {SourceUnit} unit 
 * @param {Map<string, JavaType>} androidLibrary
 */
function validate(unit, androidLibrary) {
    console.time('validation');

    let probs = [];
    const resolved_types = [
        ...resolveImports(androidLibrary, [], [], null).resolved,
        ...unit.imports.filter(i => i.resolved).map(i => i.resolved),
    ]
    unit.types.forEach(t => {
        t.initers.forEach(i => {
            const parsed = parseBody(i, resolved_types, androidLibrary);
            if (parsed)
                probs = probs.concat(parsed.problems)
        })
        t.constructors.forEach(c => {
            const parsed = parseBody(c, resolved_types, androidLibrary);
            if (parsed)
                probs = probs.concat(parsed.problems)
        })
        t.methods.forEach(m => {
            const parsed = parseBody(m, resolved_types, androidLibrary);
            if (parsed)
                probs = probs.concat(parsed.problems)
        })
    })

    const module_validaters = [
        // require('./validation/multiple-package-decls'),
        // require('./validation/unit-decl-order'),
        // require('./validation/duplicate-members'),
        // require('./validation/parse-errors'),
        require('./validation/modifier-errors'),
        require('./validation/unresolved-imports'),
        require('./validation/invalid-types'),
        require('./validation/bad-extends'),
        require('./validation/bad-implements'),
        require('./validation/non-implemented-interfaces'),
        require('./validation/bad-overrides'),
        require('./validation/missing-constructor'),
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
}
