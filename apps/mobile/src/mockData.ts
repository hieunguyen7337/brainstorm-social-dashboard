/**
 * Static content for the in-memory mock API (see mock.ts): demo brand, per-platform audience model, seed posts,
 * trend headlines and the template pools behind "Generate". Data only, no logic.
 *
 * Placeholders inside copy: {brand} {slug} {offer} {who} {theme} {trend} {trendShort} {brief} {briefShort}
 * {fact} {fact2}. Hashtags are stored without the leading '#'.
 */
import type { Platform, TrendSource } from './types';

export const DEFAULT_BRAND = 'Brew & Bloom';

export const DEFAULT_PROFILE = {
  voice:
    'Warm, witty and plain-spoken. Short sentences, a little cheeky, never salesy. We sound like the barista who remembers your order.',
  audience: 'Sydney coffee lovers, home brewers and remote workers who care where their beans come from.',
  offer: 'First bag 20% off',
};

export const LABEL: Record<Platform, string> = {
  linkedin: 'LinkedIn', instagram: 'Instagram', x: 'X', tiktok: 'TikTok', reddit: 'Reddit', facebook: 'Facebook',
};

/** Per-platform audience model: seeded followers, daily views, drift, noise and funnel ratios. */
export interface PlatformModel {
  followers: number;
  views: number; // typical daily views today; history drifts down going back in time by `growth` per 60 days
  growth: number;
  sigma: number; // day-to-day noise (+/- fraction)
  spike: number; // chance of a spike day (Reddit is spiky)
  weekly: number[]; // day-of-week multipliers, Sunday first (UTC)
  eng: number; // funnel ratios: engagements per view, clicks per engagement, conversions per click
  clk: number;
  cvr: number;
  reach: number; // lifetime views of a typical post as a multiple of followers
}

export const MODEL: Record<Platform, PlatformModel> = {
  tiktok: { followers: 48000, views: 10500, growth: 0.2, sigma: 0.18, spike: 0.015, weekly: [1.12, 0.92, 0.9, 0.95, 1, 1.08, 1.15], eng: 0.07, clk: 0.1, cvr: 0.05, reach: 0.4 },
  instagram: { followers: 21000, views: 4800, growth: 0.14, sigma: 0.12, spike: 0.01, weekly: [1.1, 0.94, 0.95, 0.98, 1, 1.04, 1.12], eng: 0.072, clk: 0.125, cvr: 0.055, reach: 0.3 },
  x: { followers: 6400, views: 1900, growth: 0.08, sigma: 0.13, spike: 0, weekly: [0.88, 1.05, 1.1, 1.08, 1.05, 0.98, 0.86], eng: 0.038, clk: 0.14, cvr: 0.05, reach: 0.5 },
  linkedin: { followers: 3100, views: 1000, growth: 0.18, sigma: 0.12, spike: 0, weekly: [0.55, 1.12, 1.25, 1.22, 1.15, 0.95, 0.5], eng: 0.052, clk: 0.22, cvr: 0.07, reach: 0.6 },
  facebook: { followers: 9800, views: 1700, growth: 0.03, sigma: 0.07, spike: 0, weekly: [1.04, 0.98, 0.97, 0.98, 1, 1.02, 1.05], eng: 0.037, clk: 0.13, cvr: 0.06, reach: 0.22 },
  reddit: { followers: 1200, views: 800, growth: 0.1, sigma: 0.22, spike: 0.08, weekly: [1.1, 0.95, 0.92, 0.95, 1, 1.05, 1.12], eng: 0.058, clk: 0.17, cvr: 0.055, reach: 5 },
};

export const SEED_THEMES = [
  { name: 'Behind the scenes', description: 'Roast days, the team and the small details behind every bag.', color: '#7c5cff' },
  { name: 'Product spotlight', description: 'New beans, blends and gear: what is on the shelf and why we love it.', color: '#ff5c8a' },
  { name: 'Customer love', description: 'Reviews, shout-outs and photos from the people who drink our coffee.', color: '#2fe0a3' },
  { name: 'Tips & how-to', description: 'Brew guides, grind tips and quick wins for better coffee at home.', color: '#ffb648' },
];

// ---- seed posts ---------------------------------------------------------------------------------

export interface SeedPost {
  platform: Platform;
  status: 'published' | 'scheduled' | 'draft';
  /** published: hours since it went live; scheduled: hours until it does; draft: hours since it was written. */
  hours: number;
  /** Index into SEED_THEMES. */
  theme: number;
  /** Relative performance (1 = typical for the platform). */
  q: number;
  content: string;
  hashtags: string[];
  media: string;
}

const TT = 'Shot list: ';

/** [platform, status, hours, theme, q, content, hashtags, media]: 16 published, 4 scheduled, 4 drafts. */
const SEEDS: [Platform, SeedPost['status'], number, number, number, string, string[], string?][] = [
  // ---- published (16) ----
  ['tiktok', 'published', 3.5, 3, 1.0,
    "Hook (0-3s): Your coffee isn't bad. Your grind is.\nBeat 1 (3-8s): Bitter and harsh? Go coarser. Sour and thin? Go finer. That's the whole trick.\nBeat 2 (8-14s): Two cups side by side, same beans, one click apart on the grinder.\nCTA (14-18s): Follow for one brew tip a day. {offer}, link in bio.",
    ['coffeetok', 'coffeetips', 'homebarista', 'sydneycoffee'],
    `${TT}1) Talking head at the kitchen bench, natural light (0-3s). 2) Overhead of the grinder dial clicking coarser (3-8s). 3) Split screen of two cups, same beans, different grind (8-14s). 4) Bag and mug end card with logo (14-18s).`],
  ['instagram', 'published', 20, 0, 1.2,
    '☕ 6am on roast day.\n\nThe first batch of the week is always the one we taste twice. Sam logs every roast by hand: time, temperature, and a note on how it smelled.\n\nSmall details, better cup. 🤎',
    ['specialtycoffee', 'sydneycoffee', 'freshroasted', 'coffeeroaster', 'behindthescenes', 'smallbatch', 'coffeelovers', '{slug}'],
    'Candid, warm-toned photo of a roaster pulling a tray of fresh beans at sunrise, steam rising, shallow depth of field, 4:5 portrait.'],
  ['x', 'published', 31, 3, 1.4,
    'If your coffee tastes bitter, try grinding a touch coarser before you blame the beans. Two clicks. That is it.',
    ['coffeetips']],
  ['linkedin', 'published', 52, 0, 1.2,
    "Running a small business teaches you that the details are the product.\n\nThis week we rebuilt how we pack orders so every bag leaves the roastery within a day of roasting. It adds a few minutes to every batch, and it's the reason our beans arrive tasting the way they should.\n\nNobody writes a headline about that, but it's what keeps people coming back.\n\nWhat's a detail in your business that customers notice more than you expect?",
    ['SmallBusiness', 'Coffee', 'CustomerExperience']],
  ['facebook', 'published', 70, 2, 0.9,
    "Okay, we're not crying, you are. 🥹 A customer told us our house blend was the best flat white she has ever made at home. Moments like this are why we get up for roast day. Thank you, Maya, and everyone who sends us their morning photos.\n\nWhat's your go-to coffee order?",
    ['customerlove', 'sydneycoffee'],
    'Smiling customer at a kitchen bench with a freshly poured flat white, natural light, landscape 16:9.'],
  ['reddit', 'published', 96, 3, 1.9,
    "Roaster here: the one brewing mistake I see everyone make\n\nWe get a lot of messages from people whose coffee tastes bitter, and it's nearly always the same thing: the water is too hot or the grind is too fine, sometimes both. Try water just off the boil (around 93 degrees) and go a touch coarser than you think you need. Weigh your coffee too, two grams either way changes the cup more than you'd expect.\n\nHappy to answer questions about any of it.",
    []],
  ['tiktok', 'published', 121, 0, 2.0,
    'Hook (0-3s): This is what a 6am roast day sounds like.\nBeat 1 (3-8s): Beans crack, the roaster hums, Sam calls out temperatures. No talking, just the sounds.\nBeat 2 (8-15s): The tray cools, we pour the first cup and taste it twice.\nCTA (15-18s): Follow along for more roast days. {offer}, link in bio.',
    ['coffeetok', 'asmr', 'coffeeroasting', 'sydney'],
    `${TT}1) Macro of beans in the roaster drum, sound on (0-3s). 2) Cooling tray sweep, steam in backlight (3-8s). 3) Sam calling out temperatures, over-the-shoulder (8-15s). 4) First cup poured, cheers to camera (15-18s).`],
  ['instagram', 'published', 150, 1, 1.9,
    '✨ New on the shelf: Ethiopia Guji, washed.\n\nBlueberry jam, jasmine and a lemony finish. Best as a filter brew: 15g of coffee to 250g of water, just off the boil.\n\n{offer}, link in bio. 🛍️',
    ['singleorigin', 'ethiopiancoffee', 'filtercoffee', 'specialtycoffee', 'sydneycafe', 'coffeegram', 'newarrival', 'pourover', 'coffeelover', '{slug}'],
    'Clean product shot of a kraft coffee bag labelled Ethiopia Guji beside a V60 and a ceramic mug, soft window light, square crop.'],
  ['x', 'published', 190, 1, 0.8,
    'New on the shelf: Ethiopia Guji. Blueberry jam, jasmine, a lemony finish. Roasted this week, ships tomorrow. ☕',
    ['specialtycoffee']],
  ['linkedin', 'published', 240, 1, 0.9,
    "We just launched a refillable bag for our house blend.\n\nCustomers asked for it. A few were already reusing our bags as plant pots (we love that), but most wanted a way to cut down on packaging without giving up freshness.\n\nSo we tested seven designs, kept the one that still has a proper valve, and priced refills below a new bag.\n\nIf you run a small product business: which customer request changed your product the most?",
    ['Sustainability', 'SmallBusiness', 'ProductDesign']],
  ['facebook', 'published', 290, 3, 0.7,
    "Quick brew tip for the weekend: rinse your paper filter before you add the coffee. It gets rid of the papery taste and pre-heats your brewer, which means a sweeter cup. ☕\n\nWhat's your weekend brew method?",
    ['coffeetips']],
  ['instagram', 'published', 340, 2, 1.3,
    "🤎 “Finally, coffee that tastes like the label says.”\n\nThat one's going on the wall. Thank you to everyone who tags us in your morning setup, we see every single one.\n\nTag us for a chance to be featured. ☕",
    ['customerlove', 'coffeelovers', 'morningritual', 'sydneycoffee', 'supportlocal', 'smallbusiness', 'coffeetime', 'homebarista'],
    'Bright lifestyle photo of a hand holding a mug by a sunny window, a notebook beside it, natural and unposed, 4:5 portrait.'],
  ['tiktok', 'published', 400, 1, 0.5,
    'Hook (0-3s): Two roasts, one big difference.\nBeat 1 (3-8s): Light roast on the left: bright, fruity, juicy. Medium on the right: round, chocolatey, sweet.\nBeat 2 (8-14s): Taste both, react honestly, pick a winner.\nCTA (14-18s): Which would you pick? Comment L or M. {offer}.',
    ['coffeetok', 'lightroast', 'mediumroast', 'coffeetasting'],
    `${TT}1) Two bowls of beans side by side (0-3s). 2) Pour-over for each roast, split screen (3-8s). 3) Tasting reactions to camera (8-14s). 4) Poll sticker and end card (14-18s).`],
  ['x', 'published', 470, 2, 1.0,
    'A customer just told us our house blend is "the reason Mondays are bearable". We will take it. 🤎',
    ['customerlove']],
  ['instagram', 'published', 560, 3, 0.9,
    '☕ Your 60-second guide to a better morning brew.\n\n1. Weigh your coffee.\n2. Water just off the boil.\n3. Rinse the filter.\n4. Bloom for 30 seconds.\n\nSave this for tomorrow morning. 🤍',
    ['brewguide', 'pourover', 'homebarista', 'coffeetips', 'specialtycoffee', 'filtercoffee', 'coffeetime', 'morningcoffee', 'sydneycoffee'],
    'Four-panel step-by-step graphic: scale, kettle, filter rinse, bloom. Clean typography, warm neutral palette, 4:5 portrait.'],
  ['tiktok', 'published', 650, 2, 0.4,
    'Hook (0-3s): Reading our reviews out loud, part 3.\nBeat 1 (3-8s): "Best flat white I have made at home." Cue the happy dance.\nBeat 2 (8-14s): "Arrived two days after roasting and tastes unreal." That is the plan.\nCTA (14-18s): Leave us a review and we will read yours next. {offer}.',
    ['coffeetok', 'customerreviews', 'smallbusiness'],
    `${TT}1) Phone screen with a review (0-3s). 2) Team reacting at the bench (3-8s). 3) Customer photo montage with captions (8-14s). 4) Thank-you to camera, end card (14-18s).`],
  // ---- scheduled (4) ----
  ['instagram', 'scheduled', 4.5, 1, 1,
    '☀️ Summer in Sydney calls for cold brew.\n\nOur 18-hour cold brew concentrate is back: smooth, low-acid and ready to pour over ice. Cut it 1:1 with water or milk.\n\n{offer}, link in bio. 🧊',
    ['coldbrew', 'summercoffee', 'sydneycoffee', 'icedcoffee', 'specialtycoffee', 'coffeelovers', 'summervibes', 'newarrival', '{slug}'],
    'Tall glass of cold brew over clear ice, condensation on the glass, bright summer light, soft beach bokeh, square crop.'],
  ['linkedin', 'scheduled', 15, 0, 1,
    "Black Friday is coming, and we've decided what we're doing about it.\n\nNo countdown timers, no \"last chance\" banners. Just one offer for new customers ({offer}) and that's it. Our best marketing has always been a good cup.\n\nIt's a smaller week for us on paper and a better one for our customers.\n\nHow is your business approaching Black Friday this year?",
    ['BlackFriday', 'SmallBusiness', 'Retail']],
  ['x', 'scheduled', 26, 0, 1,
    'Black Friday at {brand}: no countdown timers, no fake urgency. {offer} for new customers, all week. ☕',
    ['BlackFriday', 'SupportLocal']],
  ['facebook', 'scheduled', 38, 2, 1,
    "Weekend plans? Ours involve a fresh bag of Ethiopia Guji and absolutely nothing else. ☕\n\n{offer} for new customers all weekend. Tell us in the comments: what's on your weekend brew list?",
    ['weekendvibes', 'sydneycoffee'],
    'Cosy weekend kitchen scene with a pour-over setup and a fresh bag, warm morning light, landscape 16:9.'],
  // ---- drafts (4) ----
  ['tiktok', 'draft', 6, 3, 1,
    "Hook (0-3s): You've been storing your coffee wrong.\nBeat 1 (3-8s): Not the fridge, not the freezer. An airtight container, away from light and heat.\nBeat 2 (8-14s): Point at the roast date on the bag and explain the two-week sweet spot.\nCTA (14-18s): Follow for more. {offer}.",
    ['coffeetok', 'coffeetips', 'coffeestorage'],
    `${TT}1) Hook to camera holding a bag (0-3s). 2) Airtight jar on a shelf, close-up (3-8s). 3) Roast date highlighted on the bag (8-14s). 4) End card with logo (14-18s).`],
  ['reddit', 'draft', 26, 0, 1,
    "I roast coffee for a living. Ask me anything about the process.\n\nHey all, {brand} here, a small roastery in Sydney. We roast in small batches twice a week and I'm happy to answer questions about green coffee, roast profiles, or why your espresso tastes the way it does. Not here to sell anything, just here to chat.",
    []],
  ['x', 'draft', 2, 3, 1,
    'Cold brew tip: steep coarse grounds for 16 to 18 hours, filter twice, dilute 1:1. Your future summer self says thanks.',
    ['coldbrew']],
  ['linkedin', 'draft', 50, 2, 1,
    "We read every customer review out loud at our Friday huddle.\n\nIt keeps the whole team close to the people we make coffee for, and it's the fastest feedback loop we've found. Praise tells us what to protect. Complaints tell us what to fix.\n\nDo you share customer feedback with your whole team?",
    ['CustomerFeedback', 'SmallBusiness', 'TeamCulture']],
];

export const SEED_POSTS: SeedPost[] = SEEDS.map(([platform, status, hours, theme, q, content, hashtags, media]) => ({
  platform, status, hours, theme, q, content, hashtags, media: media ?? '',
}));

/** A few non-real activity entries for the seeded feed. */
export const SEED_NOTES: { type: string; platform: Platform; detail: string; hours: number }[] = [
  { type: 'click', platform: 'instagram', detail: '12 new link clicks on your Instagram posts today', hours: 7 },
  { type: 'conversion', platform: 'tiktok', detail: '2 sales came through your TikTok link', hours: 14 },
  { type: 'click', platform: 'linkedin', detail: 'Your LinkedIn post drove 9 link clicks', hours: 29 },
  { type: 'conversion', platform: 'instagram', detail: 'A sale came through your Instagram link', hours: 41 },
];

// ---- trends -------------------------------------------------------------------------------------

export interface TrendSeed {
  source: TrendSource;
  title: string;
  url: string;
  score: number;
  /** Relevance to the demo brand (a coffee roaster and small business). */
  relevance: number;
}

const hn = (id: number): string => `https://news.ycombinator.com/item?id=${id}`;
const rd = (path: string): string => `https://www.reddit.com/r/${path}/`;
const GOOGLE = 'https://trends.google.com/trending?geo=AU';

export const TREND_SEEDS: TrendSeed[] = [
  { source: 'hackernews', title: 'Why small businesses are quietly adopting AI tools', url: hn(48201133), score: 0.78, relevance: 0.74 },
  { source: 'hackernews', title: 'Ask HN: How do you run a small online shop without burning out?', url: hn(48197520), score: 0.64, relevance: 0.78 },
  { source: 'hackernews', title: 'Sustainable packaging is getting cheaper, and small brands are noticing', url: hn(48189004), score: 0.58, relevance: 0.83 },
  { source: 'hackernews', title: 'The quiet comeback of slow mornings and manual rituals', url: hn(48210376), score: 0.71, relevance: 0.68 },
  { source: 'hackernews', title: 'Show HN: A calendar that plans your week around deep work', url: hn(48205851), score: 0.83, relevance: 0.34 },
  { source: 'hackernews', title: 'Show HN: A free tool that turns receipts into spreadsheets', url: hn(48192218), score: 0.55, relevance: 0.46 },
  { source: 'hackernews', title: 'Why every developer is suddenly talking about local-first software', url: hn(48208942), score: 0.88, relevance: 0.16 },
  { source: 'reddit', title: "What's a small purchase that improved your mornings more than it should have?", url: rd('AskReddit/comments/1ox3k2a/whats_a_small_purchase_that_improved_your'), score: 0.93, relevance: 0.91 },
  { source: 'reddit', title: "What's the one thing you wish you'd known before buying a coffee machine?", url: rd('Coffee/comments/1ow8h4q/what_is_the_one_thing_you_wish_youd_known'), score: 0.74, relevance: 0.97 },
  { source: 'reddit', title: 'Black Friday: what are you actually planning to buy this year?', url: rd('AskReddit/comments/1oxa91c/black_friday_what_are_you_actually_planning_to'), score: 0.89, relevance: 0.86 },
  { source: 'reddit', title: 'I started a small business this year. Ask me anything.', url: rd('smallbusiness/comments/1ovq2zd/i_started_a_small_business_this_year_ask_me'), score: 0.61, relevance: 0.72 },
  { source: 'reddit', title: "What's the best summer drink that isn't just iced coffee?", url: rd('AskReddit/comments/1ox0b7m/whats_the_best_summer_drink_that_isnt_just_iced'), score: 0.77, relevance: 0.8 },
  { source: 'reddit', title: 'The summer cricket season is almost here. Who is backing who?', url: rd('sports/comments/1ow5n3t/the_summer_cricket_season_is_almost_here_who_is'), score: 0.69, relevance: 0.24 },
  { source: 'reddit', title: 'A tiny change to my morning routine made a surprising difference', url: rd('GetMotivated/comments/1ox6t8e/a_tiny_change_to_my_morning_routine_made_a'), score: 0.82, relevance: 0.78 },
  { source: 'google', title: 'black friday deals 2026', url: GOOGLE, score: 0.97, relevance: 0.93 },
  { source: 'google', title: 'cold brew recipe', url: GOOGLE, score: 0.66, relevance: 0.9 },
  { source: 'google', title: 'ai tools for small business', url: GOOGLE, score: 0.72, relevance: 0.76 },
  { source: 'google', title: 'sustainable gift ideas', url: GOOGLE, score: 0.58, relevance: 0.74 },
  { source: 'google', title: 'christmas shopping ideas', url: GOOGLE, score: 0.81, relevance: 0.62 },
  { source: 'google', title: 'summer holidays australia', url: GOOGLE, score: 0.75, relevance: 0.45 },
  { source: 'google', title: 'cricket live score', url: GOOGLE, score: 0.91, relevance: 0.22 },
];

// ---- generation pools ------------------------------------------------------------------------------

export type Mode = 'trend' | 'brief' | 'plain';
type Pool = Record<Mode, string[]>;

/** One-line facts per theme kind: 0 behind the scenes, 1 product, 2 customer love, 3 tips. */
export const FACTS: string[][] = [
  [
    'The first roast of the day is always the one we taste twice.',
    'Every batch gets cupped before it ships, and yes, we argue about it.',
    'Roast day starts at 6am and smells exactly as good as you imagine.',
    'Sam logs every batch by hand: time, temperature, and a note on how it smelled.',
    'We pack each bag within a day of roasting, so it reaches you at its best.',
  ],
  [
    "This week's single origin tastes like dark chocolate, orange peel and caramel.",
    'Our house blend is built for milk: sweet, round and very hard to over-extract.',
    'The new filter roast is bright and juicy, with berry notes that open up as it cools.',
    "Every bag lists the farm, the altitude and the roast date, because you should know what you're drinking.",
    'It is roasted a touch lighter, so the fruit stays loud and the bitterness stays home.',
  ],
  [
    'A customer told us it was the best flat white she has ever made at home. We are still smiling.',
    '"Finally, coffee that tastes like the label says." That one is going on the wall.',
    'Reviews like "my Monday just got easier" are the reason we get up for roast day.',
    'One of our regulars sent a photo of her morning setup and, honestly, it beats our shop.',
    'We read every review out loud at the Friday huddle. This week was a good one.',
  ],
  [
    'Rinse your paper filter first. It removes the papery taste and pre-heats your brewer.',
    'If it tastes bitter, grind a touch coarser. If it tastes sour, go a touch finer.',
    "Weigh your coffee. Two grams either way changes the cup more than you'd think.",
    'Use water just off the boil, around 93 degrees, for most filter brews.',
    'Store beans in an airtight container away from light. The fridge is not the answer.',
  ],
];

/** Brand-generic lines for when no theme is picked, so they fit any trend or brief. */
export const GENERIC_FACTS: string[] = [
  'Small batch, roasted fresh, and made with care.',
  'We roast in Sydney and ship within a day.',
  'A small team that cares about the details.',
  'Everything we sell, we would happily drink ourselves.',
  'Good coffee should be simple, fresh and a little bit fun.',
];

export const MEDIA: string[][] = [
  ['Candid, warm-toned photo of a roaster pulling a tray of fresh beans at sunrise, steam rising, shallow depth of field', 'Hands scooping freshly roasted beans into a kraft bag, soft morning light from the roastery window'],
  ['Clean product shot of a matte kraft coffee bag labelled {brand} beside a ceramic mug, soft window light, a few beans scattered', 'Flat lay of three coffee bags in a row on pale oak, one open with beans spilling, neutral background'],
  ['Bright lifestyle photo of a customer smiling over a freshly poured flat white at their kitchen bench, natural and unposed', 'Cosy window-seat photo of a hand holding a mug, a book beside it, warm afternoon light'],
  ['Overhead step-by-step close-up of a pour-over bloom with a gooseneck kettle, scale and timer visible, neutral background', 'Hands adjusting a grinder dial with two cups of coffee behind, clean kitchen bench, soft light'],
  ['Warm, natural-light lifestyle shot of a mug of coffee on a wooden table, shallow depth of field', 'Overhead flat lay of coffee beans, a mug and a handwritten note on a wooden table'],
];

export const SHOTS: string[] = [
  'Shot list: 1) Macro of beans in the roaster drum (0-3s). 2) Cooling tray sweep with steam in backlight (3-8s). 3) Roaster calling out temperatures, over-the-shoulder (8-14s). 4) First cup poured, cheers to camera (14-18s).',
  'Shot list: 1) Bag hero shot on the bench, slow push-in (0-3s). 2) Beans pouring into a bowl, close-up (3-8s). 3) Brew in progress with tasting notes as text overlay (8-14s). 4) First sip reaction, logo end card (14-18s).',
  'Shot list: 1) Screen recording of a review (0-3s). 2) Team reacting at the roastery bench (3-8s). 3) Customer photo montage with captions (8-14s). 4) Thank-you to camera, end card (14-18s).',
  'Shot list: 1) Talking head at the kitchen bench, natural light (0-3s). 2) Overhead of the grinder dial clicking coarser (3-8s). 3) Split screen of two cups, same beans, different grind (8-14s). 4) Bag and mug end card with logo (14-18s).',
  'Shot list: 1) Close-up hook to camera (0-3s). 2) B-roll of the roastery at work (3-8s). 3) Key point as text overlay over a pour (8-14s). 4) Bag and mug end card with logo (14-18s).',
];

export const TAGS = {
  coffee: ['specialtycoffee', 'sydneycoffee', 'coffeelovers', 'coffeetime', 'freshroasted', 'singleorigin', 'coffeegram', 'barista', 'homebarista', 'pourover', 'smallbatch', 'morningritual', 'coffeeaddict', 'supportlocal', 'sydneyeats'],
  biz: ['SmallBusiness', 'Entrepreneurship', 'CustomerExperience', 'Leadership', 'ShopLocal'],
  x: ['coffee', 'specialtycoffee', 'SydneyCoffee', 'coffeetips'],
  tiktok: ['coffeetok', 'coffeetips', 'baristalife', 'morningroutine', 'smallbusiness', 'fyp'],
  facebook: ['sydneycoffee', 'supportlocal', 'coffeelovers'],
};

export const COPY: {
  x: Pool;
  linkedin: { open: Pool; insight: string[]; takeaway: string[]; question: string[] };
  instagram: { hook: Pool; cta: string[] };
  tiktok: { hook: Pool; cta: string[] };
  reddit: { title: Pool; body: string[] };
  facebook: { open: Pool; ask: string[] };
} = {
  x: {
    trend: [
      "“{trendShort}” is everywhere today. We're staying in our lane. {fact}",
      'Saw “{trendShort}” trending and had to jump in. {fact}',
      'Hot take on “{trendShort}”: a good coffee and a short walk fixes most things. {fact}',
      "Everyone's talking about “{trendShort}”. Here's our take. {fact}",
    ],
    brief: ['{brief} {fact}', 'Update from {brand}: {brief} {fact}', '{brief} ☕ {offer}.'],
    plain: [
      "{fact} That's the whole job. ☕",
      'Today at {brand}: {fact}',
      'Small thing worth knowing: {fact}',
      '{theme}, {brand} edition. {fact}',
      '{fact} {offer} this week.',
      '{fact} Worth a try.',
    ],
  },
  linkedin: {
    open: {
      trend: [
        '“{trend}” has been all over my feed this week, and it got me thinking about how we run {brand}.',
        "Everyone seems to be talking about “{trend}” right now. Here's how it looks from a small business.",
        '“{trend}” is a headline I keep coming back to as a small business owner.',
      ],
      brief: ["A quick update from the {brand} team. {brief} Here's the thinking behind it.", "{brief} Here's why it matters to us."],
      plain: [
        'Running a small business teaches you that the details are the product.',
        'A small lesson from the {brand} team this week.',
        "Some of the best lessons we've learned came from the smallest decisions.",
      ],
    },
    insight: [
      "{fact} It's a tiny thing, but customers notice, and so do we.",
      "{fact} Nobody writes a headline about that, but it's what keeps people coming back.",
      "Here's what we keep relearning. {fact}",
    ],
    takeaway: [
      'The takeaway for us: consistency beats big gestures every time.',
      'So we keep it simple and do the small things well, every single day.',
      "Our rule of thumb: if it makes the product better, it's worth the extra five minutes.",
    ],
    question: [
      "What's one small habit that's made the biggest difference in your work?",
      "What's a detail in your business that customers notice more than you expect?",
      'How do you decide which details are worth the extra effort?',
      "What's the best lesson a small decision has taught you?",
    ],
  },
  instagram: {
    hook: {
      trend: ["☕ “{trendShort}”? We'd rather talk about what's in your cup.", "✨ Trending today: “{trendShort}”. Here's our take.", '🌿 “{trendShort}” and yes, we have thoughts.'],
      brief: ['☕ {brief}', '✨ {brief}'],
      plain: ['☕ Slow mornings start here.', '✨ This week at {brand}.', '🤎 The small details make the cup.', '🌿 Fresh roasted, small batch, no shortcuts.', '☀️ Good coffee, good morning.'],
    },
    cta: ['Save this for your next brew 🤍', 'Tag someone who needs this with their coffee ☕', '{offer}, link in bio 🛍️', "Double tap if your morning isn't complete without it 💛"],
  },
  tiktok: {
    hook: {
      trend: ["“{trendShort}”? Here's what that looks like in a coffee roastery.", 'POV: you saw “{trendShort}” and now you need a coffee.', "Everyone's talking about “{trendShort}”, so here's our take."],
      brief: ['Wait for it: {brief}', "{brief} Here's what that means."],
      plain: ['Stop scrolling if you drink coffee at home.', 'Nobody tells you this about coffee.', "Here's what happens at {brand} before 7am.", 'This is why your coffee tastes off.'],
    },
    cta: ['Follow for more small-batch coffee tips. {offer}, link in bio.', "Comment your go-to brew and I'll reply with a tweak.", 'Save this for tomorrow morning. {offer}, link in bio.'],
  },
  reddit: {
    title: {
      trend: ["Anyone else thinking about “{trendShort}”? Curious how other small shops see it", 'How is “{trendShort}” changing things for small businesses where you are?', 'Does “{trendShort}” matter to you, or is it just noise?'],
      brief: ['Roaster here: {briefShort}', 'Quick question for the community: {briefShort}'],
      plain: [
        'Roaster here: the one brewing mistake I see everyone make',
        "What's the one coffee habit you picked up that actually stuck?",
        "Things I wish I'd known before roasting for a living",
        'How do you all keep your beans fresh at home?',
        'I roast coffee for a living. Ask me anything about the process.',
      ],
    },
    body: [
      "Hey all, {brand} here. {fact} Curious how everyone else handles it. What's worked for you?",
      'Not trying to sell anything, just sharing what we see every day. {fact} {fact2} Happy to answer questions about any of it.',
      'Long-time lurker, first post. {fact} Would love to hear your experiences, especially if you disagree.',
    ],
  },
  facebook: {
    open: {
      trend: ['Did you see “{trend}”? Honestly, it made us smile. {fact}', "Everyone's talking about “{trendShort}” today. Here's our take. {fact}"],
      brief: ['{brief} {fact}', 'News from the {brand} team! {brief}'],
      plain: ['Good morning from the {brand} team! {fact}', 'Calling all {who}: {fact}', 'Fresh from the roastery: {fact}', 'Quick one for our Facebook family: {fact}'],
    },
    ask: ['Tell us in the comments: how do you take your coffee?', "What's your go-to morning ritual?", 'What should we roast next? Let us know below.', 'Who is your coffee buddy? Tag them below. ☕'],
  },
};
