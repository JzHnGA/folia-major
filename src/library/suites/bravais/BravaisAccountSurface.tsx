import React from 'react';
import { createPortal } from 'react-dom';
import type { LibraryAccountSurfaceProps } from '../../core/account/account.contract';
import { useLibraryAccountPendingSwitch } from '../../core/account/useLibraryAccount';
import ConfirmDialog from '../../../components/shared/ConfirmDialog';

// src/library/suites/bravais/BravaisAccountSurface.tsx
// bravais 的 account surface：待确认切换的确认框（通用 ConfirmDialog，portal 到 body，fixed z-200）。
// 登录本身画在共用的登录窗口里（src/components/login，App 挂一个，所有 suite 共用），缝里的账户入口打开它。
// 眼下切换不再确认，这个框不会出现；surface 仍在这里，bravais 才能在没有 grid 的构建里当默认 suite
// （默认 suite 必须实现全部 surface）。
const BravaisAccountSurface: React.FC<LibraryAccountSurfaceProps> = ({ account, isDaylight }) => {
    const pendingSwitch = useLibraryAccountPendingSwitch(account);
    if (!pendingSwitch || typeof document === 'undefined') return null;
    return createPortal(
        <ConfirmDialog
            isOpen
            isDaylight={isDaylight}
            title={pendingSwitch.title}
            description={pendingSwitch.description}
            onConfirm={() => void account.confirmSwitch(pendingSwitch.request.id)}
            onClose={() => void account.cancelSwitch(pendingSwitch.request.id)}
        />,
        document.body,
    );
};

export default BravaisAccountSurface;
