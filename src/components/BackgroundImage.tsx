import { FullView } from '@components/FullView';
import SimklIconImage from '@images/simkl-icon.png';
import { Box } from '@mui/material';

interface BackgroundImageProps {
	imageUrl?: string | null;
	/** Fallback image in case {@link imageUrl} is falsy. Defaults to the Simkl logo. */
	fallbackImageUrl?: string;
}

export const BackgroundImage = ({
	imageUrl,
	fallbackImageUrl = SimklIconImage,
}: BackgroundImageProps): JSX.Element => {
	return (
		<Box>
			<FullView
				sx={{
					backgroundColor: '#000',
					backgroundImage: `url("${imageUrl || fallbackImageUrl}")`,
					backgroundPosition: 'center',
					backgroundSize: 'cover',
					backgroundRepeat: 'no-repeat',
				}}
			/>
			<FullView
				sx={{
					backgroundColor: 'rgba(0, 0, 0, 0.5)',
				}}
			/>
		</Box>
	);
};
