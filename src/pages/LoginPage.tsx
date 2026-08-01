import { SimklPendingPin } from '@apis/SimklAuth';
import { I18N } from '@common/I18N';
import { Messaging } from '@common/Messaging';
import { Session } from '@common/Session';
import { Shared } from '@common/Shared';
import { Center } from '@components/Center';
import { useHistory } from '@contexts/HistoryContext';
import { Button, CircularProgress, Link, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

export const LoginPage = (): JSX.Element => {
	const history = useHistory();
	const [isLoading, setLoading] = useState(true);
	const [pendingPin, setPendingPin] = useState<SimklPendingPin | null>(null);

	const onLoginClick = async (): Promise<void> => {
		setLoading(true);
		await Session.login();
	};

	useEffect(() => {
		const startListeners = () => {
			Shared.events.subscribe('LOGIN_SUCCESS', null, onLoginSuccess);
			Shared.events.subscribe('LOGIN_ERROR', null, onLoginError);
		};

		const stopListeners = () => {
			Shared.events.unsubscribe('LOGIN_SUCCESS', null, onLoginSuccess);
			Shared.events.unsubscribe('LOGIN_ERROR', null, onLoginError);
		};

		const onLoginSuccess = () => {
			setLoading(false);
			if (Shared.redirectPath) {
				history.push(Shared.redirectPath);
			} else {
				history.push('/home');
			}
		};

		const onLoginError = () => {
			setLoading(false);
		};

		startListeners();
		return stopListeners;
	}, []);

	useEffect(() => {
		const init = async () => {
			await Session.checkLogin();
		};

		void init();
	}, []);

	// Simkl's PIN flow runs in the background page and can wait up to 15 minutes for the
	// user to approve the code, so the spinner alone would leave them with nothing to
	// act on. The opened simkl.com/pin/{code} tab normally pre-fills the code; polling
	// for it here means the code is still visible if that ever stops working.
	useEffect(() => {
		if (!isLoading) {
			setPendingPin(null);
			return;
		}
		let isActive = true;
		const poll = async () => {
			while (isActive) {
				const pin = await Messaging.toExtension({ action: 'get-pending-pin' }).catch(() => null);
				if (!isActive) {
					return;
				}
				setPendingPin(pin);
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
		};
		void poll();
		return () => {
			isActive = false;
		};
	}, [isLoading]);

	return (
		<Center>
			{isLoading ? (
				<>
					<CircularProgress color="secondary" />
					{pendingPin && (
						<>
							<Typography sx={{ marginTop: 2 }} variant="body2">
								{I18N.translate('enterPinAt')}
							</Typography>
							<Link href={pendingPin.verification_url} rel="noopener noreferrer" target="_blank">
								{pendingPin.verification_url}
							</Link>
							<Typography sx={{ letterSpacing: '0.3em', marginTop: 1 }} variant="h5">
								{pendingPin.user_code}
							</Typography>
						</>
					)}
				</>
			) : (
				<Button color="secondary" onClick={() => void onLoginClick()} variant="contained">
					{I18N.translate('login')}
				</Button>
			)}
		</Center>
	);
};
