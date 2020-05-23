const { ModuleBlock, PackageBlock, ImportBlock, TypeDeclBlock } = require('../parser9');
const ParseProblem = require('../parsetypes/parse-problem');

/**
 * @param {ModuleBlock} mod 
 */
module.exports = function(mod) {
    let have_imports, have_type;
    const problems = [];
    for (let decl of mod.decls()) {
        let p;
        switch (true) {
            case decl instanceof PackageBlock:
                if (have_imports || have_type) {
                    p = ParseProblem.Error(decl, 'package must be declared before import and type declarations');
                }
                break;
            case decl instanceof ImportBlock:
                if (have_type) {
                    p = ParseProblem.Error(decl, 'imports must be declared before type declarations');
                }
                have_imports = true;
                break;
            case decl instanceof TypeDeclBlock:
                have_type = true;
                break;
        }
        if (p) {
            problems.push(p)
        }
    }
    return problems;
}
