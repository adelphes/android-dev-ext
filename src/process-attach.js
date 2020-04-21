const os = require('os');
const { ADBClient } = require('./adbclient');

/**
 * @param {import('vscode')} vscode 
 * @param {{serial:string}[]} devices 
 */
async function showDevicePicker(vscode, devices) {
    const prefix = 'Attach: Device ';
    const menu_options = devices.map(d => prefix + d.serial);
    let chosen_option = await vscode.window.showQuickPick(menu_options);
    if (!chosen_option) {
        return; // user cancelled
    }
    chosen_option = chosen_option.slice(prefix.length);
    const found = devices.find(d => d.serial === chosen_option);
    if (!found) {
        vscode.window.showInformationMessage('Attach failed. The device is disconnected.');
        return null;
    }
    return found;
}

/**
 * @param {import('vscode')} vscode 
 * @param {number[]} pids 
 */
async function showPIDPicker(vscode, pids) {
    const prefix = 'Android attach: ';
    const menu_options = pids.sort((a,b) => a-b).map(pid => `${prefix}${pid}`);
    let chosen_option = await vscode.window.showQuickPick(menu_options);
    if (!chosen_option) {
        return null; // user cancelled
    }
    const pid = chosen_option.slice(prefix.length);
    return parseInt(pid, 10);
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
        vscode.window.showInformationMessage('Attach failed. ADB is not running');
        return res;
    }
    const devices = await new ADBClient().list_devices();
    let device;
    switch(devices.length) {
        case 0: 
            vscode.window.showInformationMessage('Attach failed. No Android devices are connected');
            return res;
        case 1:
            device = devices[0]; // only one device - just use it
            break;
        default:
            device = await showDevicePicker(vscode, devices);
            if (!device) {
                // user cancelled picker
                res.status = 'cancelled';
                return res;
            }
            break;
    }

    let pids = await new ADBClient(device.serial).jdwp_list(5000);
    if (pids.length === 0) {
        vscode.window.showInformationMessage(
            'Attach failed. No debuggable processes are running on the device.'
            + `${os.EOL}${os.EOL}`
            + `To allow a debugger to attach, the app must have the "android:debuggable=true" attribute present in AndroidManifest.xml and be running on the device.`
            + `${os.EOL}`
            + `See https://developer.android.com/guide/topics/manifest/application-element#debug`
        );
        return res;
    }

    // always show the pid picker - even if there's only one
    const pid = await showPIDPicker(vscode, pids);
    if (pid === null) {
        // user cancelled picker
        res.status = 'cancelled';
        return res;
    }

    res.pid = pid;
    res.serial = device.serial;
    res.status = 'ok';

    return res;
}
    
module.exports = {
    selectAndroidProcessID,
}
