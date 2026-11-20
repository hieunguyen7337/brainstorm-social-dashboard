import { Redirect } from 'expo-router';

/** Unknown URL (e.g. a stale deep link): go to the entry route, which picks onboarding or the dashboard. */
export default function NotFound() {
  return <Redirect href="/" />;
}
