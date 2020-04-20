const fs = require('fs');
const path = require('path');
const { hasValidSourceFileExtension } = require('./utils/source-file');

class PackageInfo {
    /**
     * 
     * @param {string} app_root 
     * @param {string} src_folder 
     * @param {string[]} files 
     * @param {string} pkg_name
     * @param {string} package_path 
     */
    constructor(app_root, src_folder, files, pkg_name, package_path) {
        this.package = pkg_name;
        this.package_path = package_path;
        this.srcroot = path.join(app_root, src_folder),
        this.public_classes = files.reduce(
            (classes, f) => {
                // any file with a Java-identifier-compatible name and a valid extension
                const m = f.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\.\w+$/);
                if (m && hasValidSourceFileExtension(f)) {
                    classes.push(m[1]);
                }
                return classes;
            }, []);
    }

    /**
     * Scan known app folders looking for file changes and package folders
     * @param {string} app_root app root directory path
     */
    static scanSourceSync(app_root) {
        try {
            let subpaths = fs.readdirSync(app_root,'utf8');
            const done_subpaths = new Set();
            const src_packages = {
                /**
                 * most recent modification time of a source file
                 */
                last_src_modified: 0,
                /**
                 * Map of packages detected
                 * @type {Map<string,PackageInfo>}
                 */
                packages: new Map(),
            };
            while (subpaths.length) {
                const subpath = subpaths.shift();
                // just in case someone has some crazy circular links going on
                if (done_subpaths.has(subpath)) {
                    continue;
                }
                done_subpaths.add(subpath);
                let subfiles = [];
                const package_path = path.join(app_root, subpath);
                try {
                    const stat = fs.statSync(package_path);
                    src_packages.last_src_modified = Math.max(src_packages.last_src_modified, stat.mtime.getTime());
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    subfiles = fs.readdirSync(package_path, 'utf8');
                }
                catch (err) {
                    continue;
                }
                // ignore folders not starting with a known top-level Android folder
                if (!(/^(assets|res|src|main|java|kotlin)([\\/]|$)/.test(subpath))) {
                    continue;
                }
                // is this a package folder
                const pkgmatch = subpath.match(/^(src|main|java|kotlin)[\\/](.+)/);
                if (pkgmatch && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(pkgmatch[2].split(/[\\/]/).pop())) {
                    // looks good - add it to the list
                    const src_folder = pkgmatch[1]; // src, main, java or kotlin
                    const package_name = pkgmatch[2].replace(/[\\/]/g,'.');
                    src_packages.packages.set(package_name, new PackageInfo(app_root, src_folder, subfiles, package_name, package_path));
                }
                // add the subfiles to the list to process
                subpaths = subfiles.map(sf => path.join(subpath,sf)).concat(subpaths);
            }
            return src_packages;
        } catch(err) {
            throw new Error('Source path error: ' + err.message);
        }
    }

}
module.exports = {
    PackageInfo
}
