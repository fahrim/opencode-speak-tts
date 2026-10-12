# Reports the Windows default playback endpoint and its readable name, and can
# watch for changes.
#
#   .\audio_device.ps1              prints the current device once
#   .\audio_device.ps1 -WatchMs 2000 prints it now, then again on every change
#
# Two sources, because neither is enough alone:
#   - IMMDeviceEnumerator answers "which device is the default". The endpoint id
#     it returns is the only reliable way to ask that.
#   - Get-PnpDevice answers "what is it called". The registry copy of the name
#     is the short device description, so two outputs of the same sound card
#     both read as "Hoparlor" and cannot be told apart; the PnP view carries
#     the fuller name that does.
#
# The name travels as base64. PowerShell 5.1's console encoding mangles
# non-ASCII on the way out no matter which encoding is requested - forcing
# UTF-8 makes it worse by encoding the already-mangled text a second time - and
# these names are full of Turkish characters. Base64 is ASCII all the way and
# cannot be corrupted by a code page.
#
# Read only. This script never changes anything.

param([int]$WatchMs = 0)

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

function Get-OutputDevice {
    try {
        $id = [DefaultEndpoint]::Id()
        if (-not $id) { return $null }

        # The endpoint id is {flow}.{guid}; the PnP instance id wraps that pair.
        $name = ''
        $match = [regex]::Match($id, '\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}')
        if ($match.Success) {
            $instance = 'SWD\MMDEVAPI\{0.0.0.00000000}.' + $match.Value
            $device = Get-PnpDevice -InstanceId $instance | Select-Object -First 1
            if ($device -and $device.FriendlyName) { $name = $device.FriendlyName }
        }
        if (-not $name) { $name = 'Unknown output' }

        return @{
            ok   = $true
            id   = $id
            name = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($name))
        }
    }
    catch {
        return @{ ok = $false; id = ''; name = '' }
    }
}

$current = Get-OutputDevice
if ($current) { $current | ConvertTo-Json -Compress }

if ($WatchMs -le 0) { return }

# Poll rather than subscribe: the notification client needs a message pump and a
# COM callback, which buys nothing over a COM call every couple of seconds.
while ($true) {
    Start-Sleep -Milliseconds $WatchMs
    $next = Get-OutputDevice
    if (-not $next) { continue }
    if ($next.id -ne $current.id) {
        $current = $next
        $next | ConvertTo-Json -Compress
    }
}