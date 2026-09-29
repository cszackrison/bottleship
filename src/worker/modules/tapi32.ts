/**
 * TAPI 2.x stub — offline modem/voice line with zero devices so games skip dial-up paths.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";

const LINEERR_BADDEVICEID = 0x80000002;
const LINEERR_INVALAPPHANDLE = 0x80000004;
const LINEERR_INVALCALLHANDLE = 0x80000012;
const LINEERR_NODEVICE = 0x8000000b;
const LINEERR_OPERATIONUNAVAIL = 0x8000001d;
const LINEERR_STRUCTURETOOSMALL = 0x80000028;

const TAPI_API_VERSION = 0x00020000;
const LINEDEVCAPS_MIN = 256;
const VARSTRING_MIN = 16;

function writeSizePair(ptr: number, size: number): boolean {
    return Mem.writeUint32(ptr, size) && Mem.writeUint32(ptr + 4, size);
}

function zeroGuest(ptr: number, size: number): boolean {
    if (!ptr || size <= 0) return true;
    return Mem.writeBytes(ptr, new Uint8Array(size)) === size;
}

export class Tapi32 implements IModule {
    name = "tapi32";
    exports: Record<string, ThunkImplementation> = {};

    private lineApp = 0;
    private nextCall = 0x30000;

    initialize(_process: Process): void {
        const ok = () => 0;

        this.exports["lineInitialize"] = (_ctx, _mem, args) => {
            const lphLineApp = args[0] >>> 0;
            const lpdwNumDevs = args[4] >>> 0;
            this.lineApp = 0x10001;
            this.nextCall = 0x30000;
            if (lphLineApp && !Mem.writeUint32(lphLineApp, this.lineApp)) {
                return LINEERR_INVALAPPHANDLE;
            }
            if (lpdwNumDevs) Mem.writeUint32(lpdwNumDevs, 0);
            return ok();
        };

        this.exports["lineShutdown"] = () => {
            this.lineApp = 0;
            return ok();
        };

        this.exports["lineNegotiateAPIVersion"] = (_ctx, _mem, args) => {
            const lpdwAPIVersion = args[4] >>> 0;
            const lpdwExtVersion = args[5] >>> 0;
            if (lpdwAPIVersion) Mem.writeUint32(lpdwAPIVersion, TAPI_API_VERSION);
            if (lpdwExtVersion) Mem.writeUint32(lpdwExtVersion, 0);
            return ok();
        };

        this.exports["lineGetDevCaps"] = (_ctx, _mem, args) => {
            const lpLineDevCaps = args[4] >>> 0;
            if (!lpLineDevCaps) return LINEERR_NODEVICE;
            const totalSize = Mem.readUint32(lpLineDevCaps) ?? 0;
            if (totalSize < LINEDEVCAPS_MIN) {
                writeSizePair(lpLineDevCaps, LINEDEVCAPS_MIN);
                return LINEERR_STRUCTURETOOSMALL;
            }
            if (!writeSizePair(lpLineDevCaps, totalSize)) return LINEERR_INVALAPPHANDLE;
            zeroGuest(lpLineDevCaps + 8, totalSize - 8);
            return LINEERR_NODEVICE;
        };

        this.exports["lineOpen"] = () => LINEERR_NODEVICE;

        this.exports["lineClose"] = () => ok();

        this.exports["lineGetID"] = (_ctx, _mem, args) => {
            const lpDeviceID = args[4] >>> 0;
            if (!lpDeviceID) return LINEERR_INVALAPPHANDLE;
            const totalSize = Mem.readUint32(lpDeviceID) ?? 0;
            if (totalSize < VARSTRING_MIN) {
                writeSizePair(lpDeviceID, VARSTRING_MIN);
                return LINEERR_STRUCTURETOOSMALL;
            }
            if (!writeSizePair(lpDeviceID, totalSize)) return LINEERR_INVALAPPHANDLE;
            zeroGuest(lpDeviceID + 8, totalSize - 8);
            return ok();
        };

        this.exports["lineAnswer"] = () => LINEERR_OPERATIONUNAVAIL;
        this.exports["lineMakeCall"] = (_ctx, _mem, args) => {
            const lphCall = args[1] >>> 0;
            if (lphCall) Mem.writeUint32(lphCall, this.nextCall++);
            return LINEERR_OPERATIONUNAVAIL;
        };

        this.exports["lineGetCallStatus"] = () => LINEERR_INVALCALLHANDLE;
        this.exports["lineDrop"] = () => LINEERR_INVALCALLHANDLE;
        this.exports["lineDeallocateCall"] = () => LINEERR_INVALCALLHANDLE;
        this.exports["lineTranslateAddress"] = () => LINEERR_BADDEVICEID;
    }

    reset(): void {
        this.lineApp = 0;
        this.nextCall = 0x30000;
    }
}
