export const identityT = (key: string): string => key;

// Some import chains (e.g. src/i18n) call i18next.use(initReactI18next) at
// module load; keep a stub so the identity mock can replace react-i18next.
export const initReactI18next = { type: "3rdParty", init: () => undefined };

export function useTranslation() {
	return {
		t: identityT,
		i18n: { language: "en", changeLanguage: async () => undefined },
	};
}
