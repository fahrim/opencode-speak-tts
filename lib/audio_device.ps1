# Reports the Windows default playback endpoint and its readable name.
#
# Two sources, because neither is enough alone:
#   - IMMDeviceEnumerator answers "which device is the default". The endpoint id
#     it returns is the only reliable way to ask that.
#   - Get-PnpDevice answers "what is it called". The registry copy of the name
#     is the short device description, so two outputs of the same sound card
#     both read as "Hoparlor" and cannot be told apart; the PnP view carries
#     the fuller name that does.
#
# Read only. This script never changes anything.

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class DeviceEnumerator { }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
 Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out object devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
 Guid("D666063F-1587-4E43-81F1-B948E807363F")]
public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    int OpenPropertyStore(int stgmAccess, out object properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}

public class DefaultEndpoint {
    const int ERender = 0;
    const int EConsole = 0;

    // The interface must list every method in vtable order. Leaving one out
    // does not report a missing method, it silently shifts the call into the
    // wrong slot and comes back as E_INVALIDARG.
    public static string Id() {
        var e = (IMMDeviceEnumerator)(new DeviceEnumerator());
        IMMDevice device;
        Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(ERender, EConsole, out device));
        string id;
        Marshal.ThrowExceptionForHR(device.GetId(out id));
        return id;
    }
}
'@

$result = [ordered]@{ ok = $false; id = ''; name = '' }

try {
    $id = [DefaultEndpoint]::Id()
    $result.id = $id

    # The endpoint id is {flow}.{guid}; the PnP instance id wraps that same pair.
    $match = [regex]::Match($id, '\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}')
    if ($match.Success) {
        $instance = 'SWD\MMDEVAPI\{0.0.0.00000000}.' + $match.Value
        $device = Get-PnpDevice -InstanceId $instance | Select-Object -First 1
        if ($device -and $device.FriendlyName) { $result.name = $device.FriendlyName }
    }

    if (-not $result.name) { $result.name = 'Unknown output' }
    $result.ok = $true
}
catch {
    $result.name = $_.Exception.Message
}

$result | ConvertTo-Json -Compress
