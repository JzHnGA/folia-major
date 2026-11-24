import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSecurityStore } from '../../../../stores/useSecurityStore';
import { Button, Group, Row, Status, Toggle, Value, option, type SettingsGroupDef, type SettingsOptionDef } from '../kit';

// src/components/modal/settings/pages/AccountSecurityPage.tsx
// 「账户与安全」：the five pillars the listener can see and operate.
//
//   OAuth        Continue with Google; the scopes and the token's expiry are shown, not hidden.
//   Rules        Sync writes ecria/users/<uid>/... only; another account is refused server-side.
//   Encryption   The vault is sealed on this device; the button says so before anything is uploaded.
//   Biometrics   Face ID locks the app and unlocks the vault key.
//   API keys     What is public, what is secret, and where each one lives.
//
// The page is part of the settings dialog, so it is reachable offline; the actions that need the
// native plugin say so instead of failing silently in a browser build.

const ACCOUNT: SettingsGroupDef = { id: 'securityAccount', titleKey: 'options.accountGroupAccount' };
const SYNC: SettingsGroupDef = { id: 'securitySync', titleKey: 'options.accountGroupSync' };
const LOCK: SettingsGroupDef = { id: 'securityLock', titleKey: 'options.accountGroupLock' };
const STORAGE: SettingsGroupDef = { id: 'securityStorage', titleKey: 'options.accountGroupStorage' };

const O = {
    google: option(ACCOUNT, 'securityGoogle', 'options.accountGoogle'),
    lock: option(LOCK, 'securityLockToggle', 'options.accountLockToggle'),
    sync: option(SYNC, 'securitySyncNow', 'options.accountSyncNow'),
};

export const OPTIONS: SettingsOptionDef[] = Object.values(O);

const formatRemaining = (milliseconds: number): string => {
    if (milliseconds <= 0) return '0:00';
    const total = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const formatTime = (unixSeconds: number | null): string => (
    unixSeconds ? new Date(unixSeconds * 1000).toLocaleTimeString() : '—'
);

const formatSavedAt = (milliseconds: number | null): string => (
    milliseconds ? new Date(milliseconds).toLocaleString() : '—'
);

const AccountSecurityPage: React.FC = () => {
    const { t } = useTranslation();
    const {
        available, status, auth, vaultMeta, loading, busy, error, notice,
        initialize, signIn, refreshSession, signOut, setLock, lock, syncNow, restore, resetVault, dismissMessages,
    } = useSecurityStore();

    const [now, setNow] = useState(Date.now());
    const [resetArmed, setResetArmed] = useState(false);

    useEffect(() => {
        void initialize();
    }, [initialize]);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!resetArmed) return;
        const timer = window.setTimeout(() => setResetArmed(false), 6000);
        return () => window.clearTimeout(timer);
    }, [resetArmed]);

    const remaining = auth.expiresAt ? auth.expiresAt * 1000 - now : 0;
    const expiresIn = useMemo(() => formatRemaining(remaining), [remaining]);

    if (!available) {
        return (
            <Group def={ACCOUNT}>
                <Row label={t('options.accountNativeOnly')} hint={t('options.accountNativeOnlyDesc')}>
                    <Status>{t('options.accountUnavailable')}</Status>
                </Row>
            </Group>
        );
    }

    const configured = status?.configured ?? false;
    const biometricLabel = status?.biometricLabel ?? 'Face ID';
    const lockEnabled = status?.lockEnabled ?? false;
    const canAct = busy === null;
    // 按钮因为「还没登录」而不可用时，点它会说明原因（kit 的 disabledReason）；忙碌中的禁用不解释，一会儿就恢复。
    const signInFirst = auth.signedIn ? undefined : t('options.accountWhySignIn');

    return (
        <>
            {(error || notice) && (
                <div className="mx-1 mb-4 rounded-lg bg-[var(--st-fill)] px-3 py-2 text-xs leading-[18px]">
                    <div className="flex items-start justify-between gap-3">
                        <span className={error ? 'text-[color:var(--st-err)]' : 'text-[color:var(--st-t2)]'}>
                            {error ?? notice}
                        </span>
                        <Button variant="quiet" onClick={dismissMessages}>{t('options.accountDismiss')}</Button>
                    </div>
                </div>
            )}

            <Group def={ACCOUNT} foot={configured ? undefined : t('options.accountNotConfiguredDesc')}>
                <Row option={O.google} hint={auth.signedIn ? (auth.email ?? auth.displayName ?? auth.uid ?? '') : t('options.accountGoogleDesc')}>
                    {auth.signedIn ? (
                        <Button variant="quiet" onClick={() => void signOut()} disabled={!canAct}>
                            {t('options.accountSignOut')}
                        </Button>
                    ) : (
                        <Button variant="primary" onClick={() => void signIn()} disabled={!canAct || !configured} disabledReason={configured ? undefined : t('options.accountWhyNotConfigured')}>
                            {busy === 'signin' ? t('options.accountSigningIn') : t('options.accountGoogle')}
                        </Button>
                    )}
                </Row>

                <Row label={t('options.accountProvider')} hint={t('options.accountProviderDesc')}>
                    <Value>{auth.signedIn ? 'google.com' : '—'}</Value>
                </Row>

                <Row label={t('options.accountScopes')} hint={t('options.accountScopesDesc')}>
                    <Value>{t('options.accountScopesValue')}</Value>
                </Row>

                <Row
                    label={t('options.accountToken')}
                    hint={auth.signedIn ? t('options.accountTokenDesc') : t('options.accountTokenSignedOut')}
                >
                    {auth.signedIn ? (
                        <span className="flex items-center gap-2">
                            <Value tip={formatTime(auth.expiresAt)}>{expiresIn}</Value>
                            <Button variant="quiet" onClick={() => void refreshSession()} disabled={!canAct}>
                                {t('options.accountRefresh')}
                            </Button>
                        </span>
                    ) : (
                        <Value>—</Value>
                    )}
                </Row>

                <Row label={t('options.accountUid')} hint={t('options.accountUidDesc')}>
                    <Value tip={auth.uid ?? undefined}>{auth.uid ? `${auth.uid.slice(0, 10)}…` : '—'}</Value>
                </Row>
            </Group>

            <Group def={SYNC}>
                <Row option={O.sync} hint={t('options.accountSyncDesc')}>
                    <Button variant="primary" onClick={() => void syncNow()} disabled={!canAct || !auth.signedIn} disabledReason={signInFirst}>
                        {busy === 'sync' ? t('options.accountSyncing') : t('options.accountSyncNow')}
                    </Button>
                </Row>

                <Row label={t('options.accountRestore')} hint={t('options.accountRestoreDesc')}>
                    <Button onClick={() => void restore()} disabled={!canAct || !auth.signedIn} disabledReason={signInFirst}>
                        {busy === 'restore' ? t('options.accountRestoring') : t('options.accountRestore')}
                    </Button>
                </Row>

                <Row label={t('options.accountVault')} hint={t('options.accountVaultDesc')}>
                    <Status tone={status?.hasVaultKey ? 'ok' : undefined}>
                        {status?.hasVaultKey ? t('options.accountVaultReady') : t('options.accountVaultEmpty')}
                    </Status>
                </Row>

                <Row label={t('options.accountLastSync')} hint={t('options.accountLastSyncDesc')}>
                    <Value>{formatSavedAt((vaultMeta?.savedAt ?? null))}</Value>
                </Row>

                <Row label={t('options.accountFresh')} hint={t('options.accountFreshDesc')}>
                    <Button
                        variant={resetArmed ? 'primary' : undefined}
                        onClick={() => {
                            if (!resetArmed) {
                                setResetArmed(true);
                                return;
                            }
                            setResetArmed(false);
                            void resetVault();
                        }}
                        disabled={!canAct || !auth.signedIn}
                        disabledReason={signInFirst}
                    >
                        {resetArmed ? t('options.accountFreshConfirm') : t('options.accountFresh')}
                    </Button>
                </Row>
            </Group>

            <Group def={LOCK} foot={t('options.accountLockFoot')}>
                <Row option={O.lock} hint={lockEnabled ? t('options.accountLockOn') : t('options.accountLockOff')}>
                    <Toggle
                        checked={lockEnabled}
                        onChange={enabled => void setLock(enabled)}
                        disabled={!canAct || !status?.biometrics}
                        disabledReason={status?.biometrics ? undefined : t('options.accountWhyNoBiometrics', { biometric: biometricLabel })}
                    />
                </Row>

                <Row label={t('options.accountLockNow')} hint={t('options.accountLockNowDesc')}>
                    <Button onClick={() => void lock()} disabled={!lockEnabled} disabledReason={t('options.accountWhyLockOff', { biometric: biometricLabel })}>
                        {t('options.accountLockNow')}
                    </Button>
                </Row>

                <Row label={t('options.accountBiometrics')} hint={t('options.accountBiometricsDesc')}>
                    <Status tone={status?.biometrics ? 'ok' : 'warn'}>
                        {status?.biometrics ? biometricLabel : t('options.accountBiometricsMissing')}
                    </Status>
                </Row>
            </Group>

            <Group def={STORAGE}>
                <Row label={t('options.accountNetEase')} hint={t('options.accountNetEaseDesc')}>
                    <Status tone="ok">{t('options.accountKeychainValue')}</Status>
                </Row>
                <Row label={t('options.accountVaultKey')} hint={t('options.accountVaultKeyDesc')}>
                    <Status tone={status?.hasVaultKey ? 'ok' : undefined}>{t('options.accountVaultKeyValue', { biometric: biometricLabel })}</Status>
                </Row>
                <Row label={t('options.accountPublicKeys')} hint={t('options.accountPublicKeysDesc')}>
                    <Value>{t('options.accountPublicKeysValue')}</Value>
                </Row>
                <Row label={t('options.accountSecretKeys')} hint={t('options.accountSecretKeysDesc')}>
                    <Value>{t('options.accountSecretKeysValue')}</Value>
                </Row>
            </Group>

            {loading && (
                <p className="mx-1 mt-4 text-xs text-[color:var(--st-t3)]">{t('options.accountLoading')}</p>
            )}
        </>
    );
};

export default AccountSecurityPage;
