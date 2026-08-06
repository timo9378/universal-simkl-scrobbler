import { TextField } from '@mui/material';
import { ChangeEvent, KeyboardEvent, useEffect, useState } from 'react';

interface TextOptionProps extends WithSx {
	id: string;
	value: string;
	isDisabled: boolean;
	handleChange: (id: string, newValue: string) => void;
}

/**
 * A free-text option.
 *
 * Committing on blur/Enter rather than on every keystroke is deliberate: `handleChange`
 * writes straight through to storage and broadcasts a change event, so per-character
 * saving would fire ~30 writes for one pasted client id — and each of those would also
 * invalidate the API instances mid-typing.
 */
export const TextOption = ({
	id,
	value: initialValue,
	isDisabled,
	handleChange,
	sx = {},
}: TextOptionProps): JSX.Element => {
	const [value, setValue] = useState(initialValue);

	const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
		setValue(event.target.value);
	};

	const commit = () => {
		const trimmed = value.trim();
		if (trimmed !== value) {
			setValue(trimmed);
		}
		if (trimmed !== initialValue) {
			handleChange(id, trimmed);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Enter') {
			(event.target as HTMLInputElement).blur();
		}
	};

	useEffect(() => {
		setValue(initialValue);
	}, [initialValue]);

	return (
		<TextField
			disabled={isDisabled}
			value={value}
			onChange={onChange}
			onBlur={commit}
			onKeyDown={onKeyDown}
			size="small"
			spellCheck={false}
			sx={{ minWidth: 320, ...sx }}
		/>
	);
};
