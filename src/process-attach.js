const os = require('os');
const { ADBClient } = require('./adbclient');
const { selectTargetDevice } = require('./utils/device');

/**
 * @param {import('vscode')} vscode 
 * @param {{pid:number,name:string}[]} pids 
 */
async function showPIDPicker(vscode, pids) {
    // sort by PID (the user can type the package name to search)
    const sorted_pids = pids.slice().sort((a,b) => a.pid - b.pid);

    /** @type {import('vscode').QuickPickItem[]} */
    const device_pick_items = sorted_pids
        .map(x => ({
            label: `${x.pid}`,
            description: x.name,
        }));

    /** @type {import('vscode').QuickPickOptions} */
    const device_pick_options = {
        matchOnDescription: true,
        canPickMany: false,
        placeHolder: 'Choose the Android process to attach to',
    };

    const chosen_option = await vscode.window.showQuickPick(device_pick_items, device_pick_options);
    return sorted_pids[device_pick_items.indexOf(chosen_option)] || null;
}

/**
 * @param {import('vscode')} vscode 
 */
async function selectAndroidProcessID(vscode) {
    const res = {
        /** @type {string|'ok'|'cancelled'|'failed'} */
        status: 'failed',
        pid: 0,
        serial: '',
    }
    const err = await new ADBClient().test_adb_connection()
    if (err) {
        vscode.window.showWarningMessage('Attach failed. ADB is not running.');
        return res;
    }

    const device = await selectTargetDevice(vscode, 'Attach');
    if (!device) {
        // user cancelled picker
        res.status = 'cancelled';
        return res;
    }

    let named_pids = await new ADBClient(device.serial).named_jdwp_list(5000);
    if (named_pids.length === 0) {
        vscode.window.showWarningMessage(
            'Attach failed. No debuggable processes are running on the device.'
            + `${os.EOL}${os.EOL}`
            + `To allow a debugger to attach, the app must have the "android:debuggable=true" attribute present in AndroidManifest.xml and be running on the device.`
            + `${os.EOL}`
            + `See https://developer.android.com/guide/topics/manifest/application-element#debug`
        );
        return res;
    }

    // always show the pid picker - even if there's only one
    const named_pid = await showPIDPicker(vscode, named_pids);
    if (named_pid === null) {
        // user cancelled picker
        res.status = 'cancelled';
        return res;
    }

    res.pid = named_pid.pid;
    res.serial = device.serial;
    res.status = 'ok';

    return res;
}
    
module.exports = {
    selectAndroidProcessID,
}
