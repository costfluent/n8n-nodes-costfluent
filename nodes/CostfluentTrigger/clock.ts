/** Where the trigger reads the current time; tests replace `now` to pin it. */
export const clock = {
	now: (): number => Date.now(),
};
