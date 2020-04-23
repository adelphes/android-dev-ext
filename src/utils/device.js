const { ADBClient } = require('../adbclient');

/**
 * @param {import('vscode')} vscode 
 * @param {{serial:string}[]} devices 
 */
async function showDevicePicker(vscode, devices) {
    const sorted_devices = devices.slice().sort((a,b) => a.serial.localeCompare(b.serial, undefined, {sensitivity: 'base'}));

    /** @type {import('vscode').QuickPickItem[]} */
    const quick_pick_items = sorted_devices
        .map(device => ({
            label: `${device.serial}`,
        }));

    /** @type {import('vscode').QuickPickOptions} */
    const quick_pick_options = {
        canPickMany: false,
        placeHolder: 'Choose an Android device',
    };

    const chosen_option = await vscode.window.showQuickPick(quick_pick_items, quick_pick_options);
    return sorted_devices[quick_pick_items.indexOf(chosen_option)] || null;
}

/**
 * 
 * @param {import('vscode')} vscode 
 * @param {'Attach'|'Logcat display'} action 
 */
async function selectTargetDevice(vscode, action) {
    const devices = await new ADBClient().list_devices();
    let device;
    switch(devices.length) {
        case 0: 
            vscode.window.showWarningMessage(`${action} failed. No Android devices are connected.`);
            return null;
        case 1:
            return devices[0]; // only one device - just use it
    }
    device = await showDevicePicker(vscode, devices);
    // the user might take a while to choose the device, so once
    // chosen, recheck it exists
    const current_devices = await new ADBClient().list_devices();
    if (!current_devices.find(d => d.serial === device.serial)) {
        vscode.window.showInformationMessage(`${action} failed. The target device is disconnected`);
        return null;
    }
    return device;
}

module.exports = {
    selectTargetDevice,
    showDevicePicker,
}
