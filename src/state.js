const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

var adext = {};
try {
    Object.assign(adext, JSON.parse(fs.readFileSync(path.join(path.dirname(__dirname),'package.json'),'utf8')));
} catch (ex) { }

exports.adext = adext;
