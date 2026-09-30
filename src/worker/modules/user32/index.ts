// Auto-generated index for user32 module
// This file aggregates all atomic implementations
// Generated from directory scan: src/worker/modules/user32

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { createAcceleratorExports as accelerator } from './accelerator';
import { createClassExports as class_ } from './class';
import { createDialogExports as dialog } from './dialog';
import { createInputExports as input } from './input';
import { createMenuExports as menu } from './menu';
import { createMessageExports as message, registerFastPathMessageFunctions as registerFastPathmessage } from './message';
import { createSystemExports as system } from './system';
import { createWindowExports as window } from './window';
import { resetUser32SharedState } from './shared-state';

export class User32 implements IModule {
    name = 'user32';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // accelerator functions
        Object.assign(this.exports, accelerator());
        // class functions
        Object.assign(this.exports, class_());
        // dialog functions
        Object.assign(this.exports, dialog());
        // input functions
        Object.assign(this.exports, input());
        // menu functions
        Object.assign(this.exports, menu());
        // message functions
        Object.assign(this.exports, message());
        registerFastPathmessage(process.dispatcher);
        // system functions
        Object.assign(this.exports, system());
        // window functions
        Object.assign(this.exports, window());
    }

    reset(): void {
        resetUser32SharedState();
    }
}