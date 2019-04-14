const { workspace, EventEmitter, Uri } = require('vscode');

class AndroidContentProvider /*extends TextDocumentContentProvider*/ {

    constructor() {
        this._docs = {};    // hashmap<url, LogcatContent>
        this._onDidChange = new EventEmitter();
    }

    dispose() {
        this._onDidChange.dispose();
    }

    /**
     * An event to signal a resource has changed.
     */
    get onDidChange() {
        return this._onDidChange.event;
    }

    /**
     * Provide textual content for a given uri.
     *
     * The editor will use the returned string-content to create a readonly
     * [document](TextDocument). Resources allocated should be released when
     * the corresponding document has been [closed](#workspace.onDidCloseTextDocument).
     *
     * @param uri An uri which scheme matches the scheme this provider was [registered](#workspace.registerTextDocumentContentProvider) for.
     * @param token A cancellation token.
     * @return A string or a thenable that resolves to such.
     */
    provideTextDocumentContent(uri/*: Uri, token: CancellationToken*/)/*: string | Thenable<string>;*/ {
        const doc = this._docs[uri];
        if (doc) {
            return doc.content;
        }
        switch (uri.authority) {
            // android-dev-ext://logcat/read?<deviceid>
            case 'logcat': return this.provideLogcatDocumentContent(uri);
        }
        throw new Error('Document Uri not recognised');
    }

    provideLogcatDocumentContent(uri) {
        // LogcatContent depends upon AndroidContentProvider, so we must delay-load this
        const { LogcatContent } = require('./logcat');
        const doc = this._docs[uri] = new LogcatContent(uri.query);
        return doc.content;
    }
}

AndroidContentProvider.SCHEME = 'android-dev-ext';

AndroidContentProvider.register = (ctx, workspace) => {
    const provider = new AndroidContentProvider();
    const registration = workspace.registerTextDocumentContentProvider(AndroidContentProvider.SCHEME, provider);
    ctx.subscriptions.push(registration, provider);
}

AndroidContentProvider.getReadLogcatUri = (deviceId) => {
    const uri = Uri.parse(`${AndroidContentProvider.SCHEME}://logcat/logcat-${deviceId}.txt`);
    return uri.with({
        query: deviceId
    });
}

AndroidContentProvider.getLaunchConfigSetting = (name, defvalue) => {
    // there's surely got to be a better way than this...
    const configs = workspace.getConfiguration('launch.configurations');
    for (let i = 0, config; config = configs.get(`${i}`); i++) {
        if (config.type!=='android') {
            continue;
        }
        if (config.request!=='launch') {
            continue;
        }
        if (config[name]) {
            return config[name];
        }
        break;
    }
    return defvalue;
}

exports.AndroidContentProvider = AndroidContentProvider;
