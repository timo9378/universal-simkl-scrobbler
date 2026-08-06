import { TextField } from '@mui/material';
import { ChangeEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';

/** How long to wait after the last keystroke before saving. */
const COMMIT_DELAY_MS = 600;

interface TextOptionProps extends WithSx {
	id: string;
	value: string;
	isDisabled: boolean;
	handleChange: (id: string, newValue: string) => void;
}

/**
 * A free-text option.
 *
 * Saving is debounced rather than fired per keystroke: `handleChange` writes straight
 * through to storage and broadcasts a change event, so per-character saving would mean
 * ~64 writes for one pasted client id, each invalidating the API instances mid-typing.
 *
 * It is *only* debounced, never deferred until blur. Blur-to-save fails silently in the
 * one case that matters — paste the id, close the tab, and nothing was written, while
 * the field looked filled in the whole time. Blur and Enter commit immediately, and
 * `pagehide` flushes whatever is still pending, because React's unmount cleanup is not
 * guaranteed to run when a tab closes.
 */
export const TextOption = ({
	id,
	value: initialValue,
	isDisabled,
	handleChange,
	sx = {},
}: TextOptionProps): JSX.Element => {
	const [value, setValue] = useState(initialValue);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Read inside the timer/pagehide callbacks so a pending save always sees the latest
	// text rather than whatever was current when the callback was created.
	const latest = useRef(initialValue);
	const saved = useRef(initialValue);

	const clearTimer = () => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
	};

	const commit = () => {
		clearTimer();
		const trimmed = latest.current.trim();
		latest.current = trimmed;
		setValue(trimmed);
		if (trimmed !== saved.current) {
			saved.current = trimmed;
			handleChange(id, trimmed);
		}
	};

	const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
		const newValue = event.target.value;
		setValue(newValue);
		latest.current = newValue;
		clearTimer();
		timer.current = setTimeout(commit, COMMIT_DELAY_MS);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Enter') {
			(event.target as HTMLInputElement).blur();
		}
	};

	useEffect(() => {
		setValue(initialValue);
		latest.current = initialValue;
		saved.current = initialValue;
	}, [initialValue]);

	useEffect(() => {
		const flush = () => {
			if (timer.current !== null) {
				commit();
			}
		};
		window.addEventListener('pagehide', flush);
		return () => {
			window.removeEventListener('pagehide', flush);
			flush();
		};
	}, []);

	return (
		<TextField
			disabled={isDisabled}
			value={value}
			onChange={onChange}
			onBlur={commit}
			onKeyDown={onKeyDown}
			size="small"
			spellCheck={false}
			fullWidth
			// A client ID is 64 hex characters. At the default width and font this shows
			// about a third of one, so a paste can't be eyeballed for completeness.
			slotProps={{ input: { sx: { fontFamily: 'monospace' } } }}
			sx={{ maxWidth: 640, mt: 1, ...sx }}
		/>
	);
};
