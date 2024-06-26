import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppDispatch, useAppSelector } from 'src/app/hooks'
import { useBiometricAppSettings, useBiometricPrompt } from 'src/features/biometrics/hooks'
import { closeAllModals } from 'src/features/modals/modalSlice'
import { selectModalState } from 'src/features/modals/selectModalState'
import { getEncryptedMnemonic } from 'src/features/scantastic/ScantasticEncryption'
import { Button, Flex, Text, TouchableArea, useSporeColors } from 'ui/src'
import { AlertTriangle, Faceid, Laptop, LinkBrokenHorizontal, Wifi } from 'ui/src/components/icons'
import { iconSizes } from 'ui/src/theme'
import { BottomSheetModal } from 'uniswap/src/components/modals/BottomSheetModal'
import { uniswapUrls } from 'uniswap/src/constants/urls'
import { ModalName } from 'uniswap/src/features/telemetry/constants'
import { logger } from 'utilities/src/logger/logger'
import { ONE_MINUTE_MS, ONE_SECOND_MS } from 'utilities/src/time/time'
import { useInterval } from 'utilities/src/time/timing'
import {
  ExtensionOnboardingState,
  setExtensionOnboardingState,
} from 'wallet/src/features/behaviorHistory/slice'
import { pushNotification } from 'wallet/src/features/notifications/slice'
import { AppNotificationType } from 'wallet/src/features/notifications/types'
import { useSignerAccounts } from 'wallet/src/features/wallet/hooks'
import { getOtpDurationString } from 'wallet/src/utils/duration'

const IP_MISMATCH_STATUS_CODE = 401

enum OtpState {
  Pending = 'pending',
  Redeemed = 'redeemed',
  Expired = 'expired',
}
interface OtpStateApiResponse {
  otp?: OtpState
  expiresAtInSeconds?: number
}

export function ScantasticModal(): JSX.Element | null {
  const { t } = useTranslation()
  const colors = useSporeColors()
  const dispatch = useAppDispatch()

  // Use the first mnemonic account because zero-balance mnemonic accounts will fail to retrieve the mnemonic from rnEthers
  const account = useSignerAccounts().sort(
    (account1, account2) => account1.derivationIndex - account2.derivationIndex
  )[0]

  if (!account) {
    throw new Error('This should not be accessed with no mnemonic accounts')
  }

  const { initialState } = useAppSelector(selectModalState(ModalName.Scantastic))
  const params = initialState?.params

  const [OTP, setOTP] = useState('')
  // Once a user has scanned a QR they have 6 minutes to correctly input the OTP
  const [expirationTimestamp, setExpirationTimestamp] = useState<number>(
    Date.now() + 6 * ONE_MINUTE_MS
  )
  const pubKey = params?.publicKey
  const uuid = params?.uuid
  const device = `${params?.vendor || ''} ${params?.model || ''}`.trim()
  const browser = params?.browser || ''

  const [expired, setExpired] = useState(false)
  const [redeemed, setRedeemed] = useState(false)
  const [error, setError] = useState('')

  // Warning state if backend response identifies mismatched IPs between devices
  const [showIPWarning, setShowIPWarning] = useState(false)

  const [expiryText, setExpiryText] = useState('')
  const setExpirationText = useCallback(() => {
    const expirationString = getOtpDurationString(expirationTimestamp)
    setExpiryText(expirationString)
  }, [expirationTimestamp])
  useInterval(setExpirationText, ONE_SECOND_MS)

  if (redeemed) {
    dispatch(
      pushNotification({
        type: AppNotificationType.ScantasticComplete,
        hideDelay: 6 * ONE_SECOND_MS,
      })
    )
    dispatch(setExtensionOnboardingState(ExtensionOnboardingState.Completed))
    dispatch(closeAllModals())
  }

  useEffect(() => {
    const interval = setInterval(() => {
      const timeLeft = expirationTimestamp - Date.now()
      setExpired(timeLeft <= 0)
    }, ONE_SECOND_MS)

    return () => clearInterval(interval)
  }, [expirationTimestamp, t])

  const onClose = useCallback((): void => {
    dispatch(closeAllModals())
  }, [dispatch])

  const onEncryptSeedphrase = async (): Promise<void> => {
    if (!pubKey) {
      return
    }

    setError('')
    let encryptedSeedphrase = ''
    const { n, e } = pubKey
    try {
      encryptedSeedphrase = await getEncryptedMnemonic(account?.address || '', n, e)
    } catch (err) {
      setError(t('scantastic.error.encryption'))
      logger.error(err, {
        tags: {
          file: 'ScantasticModal',
          function: 'onEncryptSeedphrase->getEncryptedMnemonic',
        },
        extra: {
          address: account?.address,
          n,
          e,
        },
      })
    }

    try {
      // submit encrypted blob
      const response = await fetch(`${uniswapUrls.scantasticApiUrl}/blob`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: 'https://uniswap.org',
        },
        body: JSON.stringify({
          uuid,
          blob: encryptedSeedphrase,
        }),
      })

      if (response.status === IP_MISMATCH_STATUS_CODE) {
        setShowIPWarning(true)
        return
      }

      if (!response.ok) {
        throw new Error(`Failed to post blob: ${await response.text()}`)
      }
      const data = await response.json()
      if (!data?.otp) {
        throw new Error('OTP unavailable')
      } else {
        setExpirationTimestamp(Date.now() + ONE_MINUTE_MS * 2)
        setOTP(data.otp)
      }
    } catch (err) {
      setError(t('scantastic.error.noCode'))
      logger.error(err, {
        tags: {
          file: 'ScantasticModal',
          function: `onEncryptSeedphrase->fetch`,
        },
        extra: { uuid },
      })
    }
  }

  const { trigger: biometricTrigger } = useBiometricPrompt(onEncryptSeedphrase)
  const {
    requiredForAppAccess: biometricAuthRequiredForAppAccess,
    requiredForTransactions: biometricAuthRequiredForTransactions,
  } = useBiometricAppSettings()
  const requiresBiometricAuth =
    biometricAuthRequiredForAppAccess || biometricAuthRequiredForTransactions

  const onConfirmSync = async (): Promise<void> => {
    if (requiresBiometricAuth) {
      await biometricTrigger()
    } else {
      await onEncryptSeedphrase()
    }
  }

  const checkOTPState = useCallback(async (): Promise<void> => {
    if (!OTP || !uuid) {
      return
    }
    try {
      const response = await fetch(`${uniswapUrls.scantasticApiUrl}/otp-state/${uuid}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Origin: 'https://uniswap.org',
        },
      })
      if (!response.ok) {
        throw new Error(`Failed to check OTP state: ${await response.text()}`)
      }
      const data: OtpStateApiResponse = await response.json()
      const otpState = data.otp
      if (!otpState) {
        throw new Error('No OTP state received.')
      }
      if (data.expiresAtInSeconds) {
        setExpirationTimestamp(data.expiresAtInSeconds * ONE_SECOND_MS)
      }
      if (otpState === OtpState.Redeemed) {
        setRedeemed(true)
      }
      if (otpState === OtpState.Expired) {
        setExpired(true)
      }
    } catch (e) {
      logger.error(e, {
        tags: {
          file: 'ScantasticModal',
          function: `checkOTPState`,
        },
        extra: { uuid },
      })
    }
  }, [OTP, uuid])

  useInterval(checkOTPState, ONE_SECOND_MS, true)

  if (showIPWarning) {
    return (
      <BottomSheetModal
        backgroundColor={colors.surface1.get()}
        name={ModalName.OtpInputExpired}
        onClose={onClose}>
        <Flex centered gap="$spacing16" px="$spacing16" py="$spacing12">
          <Flex centered backgroundColor="$surface2" borderRadius="$rounded12" p="$spacing12">
            <Wifi color="$neutral2" size={iconSizes.icon24} />
          </Flex>
          <Flex centered gap="$spacing12">
            <Text variant="subheading1">{t('scantastic.modal.ipMismatch.title')}</Text>
            <Text color="$neutral2" px="$spacing16" textAlign="center" variant="body3">
              {t('scantastic.modal.ipMismatch.description')}
            </Text>
          </Flex>
          <Button theme="secondary" width="100%" onPress={onClose}>
            {t('common.button.close')}
          </Button>
        </Flex>
      </BottomSheetModal>
    )
  }

  if (expired) {
    return (
      <BottomSheetModal
        backgroundColor={colors.surface1.get()}
        name={ModalName.OtpInputExpired}
        onClose={onClose}>
        <Flex centered gap="$spacing16" px="$spacing16" py="$spacing12">
          <Flex centered backgroundColor="$surface2" borderRadius="$rounded12" p="$spacing12">
            <LinkBrokenHorizontal color="$neutral2" size={iconSizes.icon24} />
          </Flex>
          <Text variant="subheading1">{t('scantastic.error.timeout.title')}</Text>
          <Text color="$neutral2" mb="$spacing12" textAlign="center" variant="body3">
            {t('scantastic.error.timeout.message')}
          </Text>
          <Button theme="secondary" width="100%" onPress={onClose}>
            {t('common.button.close')}
          </Button>
        </Flex>
      </BottomSheetModal>
    )
  }

  if (OTP) {
    return (
      <BottomSheetModal
        backgroundColor={colors.surface1.get()}
        name={ModalName.OtpScanInput}
        onClose={onClose}>
        <Flex centered gap="$spacing16" px="$spacing16" py="$spacing12">
          <Flex centered backgroundColor="$accent2" borderRadius="$rounded12" p="$spacing12">
            <Laptop color="$accent1" size={iconSizes.icon24} />
          </Flex>
          <Text variant="subheading1">{t('scantastic.code.title')}</Text>
          <Text color="$neutral2" textAlign="center" variant="body3">
            {t('scantastic.code.subtitle')}
          </Text>
          <Flex row gap="$spacing20" py="$spacing8">
            <Text variant="heading1">{OTP.substring(0, 3).split('').join(' ')}</Text>
            <Text variant="heading1">{OTP.substring(3).split('').join(' ')}</Text>
          </Flex>
          <Text color="$neutral3" variant="body2">
            {expiryText}
          </Text>
        </Flex>
      </BottomSheetModal>
    )
  }

  if (error) {
    return (
      <BottomSheetModal
        backgroundColor={colors.surface1.get()}
        name={ModalName.OtpScanInput}
        onClose={onClose}>
        <Flex centered gap="$spacing16" px="$spacing16" py="$spacing12">
          <Flex centered backgroundColor="$accent2" borderRadius="$rounded12" p="$spacing12">
            <AlertTriangle color="$statusCritical" size={iconSizes.icon24} />
          </Flex>
          <Text variant="subheading1">{t('common.text.error')}</Text>
          <Text color="$neutral2" textAlign="center" variant="body3">
            {error}
          </Text>
          <Flex flexDirection="column" gap="$spacing4" mt="$spacing12" width="100%">
            <Button alignItems="center" theme="secondary" onPress={onClose}>
              <Text variant="buttonLabel2">{t('common.button.close')}</Text>
            </Button>
          </Flex>
        </Flex>
      </BottomSheetModal>
    )
  }

  const renderDeviceDetails = Boolean(device || browser)

  return (
    <BottomSheetModal
      backgroundColor={colors.surface1.get()}
      name={ModalName.Scantastic}
      onClose={onClose}>
      <Flex centered gap="$spacing16" px="$spacing16" py="$spacing12">
        <Flex centered backgroundColor="$accent2" borderRadius="$rounded12" p="$spacing12">
          <Laptop color="$accent1" size={iconSizes.icon24} />
        </Flex>
        <Text variant="subheading1">{t('scantastic.confirmation.title')}</Text>
        <Text color="$neutral2" textAlign="center" variant="body3">
          {t('scantastic.confirmation.subtitle')}
        </Text>
        {renderDeviceDetails && (
          <Flex
            borderColor="$surface3"
            borderRadius="$rounded20"
            borderWidth={1}
            gap="$spacing12"
            p="$spacing16"
            width="100%">
            {device && (
              <Flex row px="$spacing8">
                <Text color="$neutral2" flex={1} variant="body3">
                  {t('scantastic.confirmation.label.device')}
                </Text>
                <Text variant="body3">{device}</Text>
              </Flex>
            )}
            {browser && (
              <Flex row px="$spacing8">
                <Text color="$neutral2" flex={1} variant="body3">
                  {t('scantastic.confirmation.label.browser')}
                </Text>
                <Text variant="body3">{browser}</Text>
              </Flex>
            )}
          </Flex>
        )}
        <Flex
          row
          alignItems="center"
          backgroundColor="$surface2"
          borderRadius="$rounded16"
          gap="$spacing8"
          p="$spacing16"
          width="100%">
          <AlertTriangle color="$neutral2" size="$icon.20" />
          <Text color="$neutral2" variant="body4">
            {t('scantastic.confirmation.warning')}
          </Text>
        </Flex>
        <Flex flexDirection="column" gap="$spacing4" width="100%">
          <Button
            icon={requiresBiometricAuth ? <Faceid size={iconSizes.icon16} /> : undefined}
            mb="$spacing4"
            theme="primary"
            onPress={onConfirmSync}>
            {t('scantastic.confirmation.button.continue')}
          </Button>
          <TouchableArea alignItems="center" onPress={onClose}>
            <Text color="$accent1" py="$spacing16" variant="buttonLabel2">
              {t('common.button.cancel')}
            </Text>
          </TouchableArea>
        </Flex>
      </Flex>
    </BottomSheetModal>
  )
}
