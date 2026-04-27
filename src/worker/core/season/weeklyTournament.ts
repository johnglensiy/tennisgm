import type {
	PlayoffSeriesTeam,
	WeeklyTournamentSeries,
} from "../../../common/types.ts";
import { shuffle } from "../../../common/random.ts";
import { g } from "../../util/index.ts";
import { league } from "../index.ts";
import setSchedule from "./setSchedule.ts";

type TeamForWeeklyTournament = {
	tid: number;
	seasonAttrs: {
		cid: number;
	};
};

const makeSeeds = (teams: TeamForWeeklyTournament[]): PlayoffSeriesTeam[] => {
	// MVP: seed in the input order. Caller is responsible for deterministic ordering.
	return teams.map((t, i) => ({
		tid: t.tid,
		cid: t.seasonAttrs.cid,
		seed: i + 1,
		won: 0,
		pts: undefined,
	}));
};

const selectEntrants = (
	teams: TeamForWeeklyTournament[],
	week: number,
): TeamForWeeklyTournament[] => {
	// MVP: pick 16 random active teams, but deterministically for a given league/season/week.
	// This avoids needing standings data, while still producing stable results on reload/resim.
	const seed =
		(g.get("lid") ?? 0) * 1000000 + g.get("season") * 1000 + Math.max(0, week);

	const shuffled = [...teams];
	shuffle(shuffled, seed);

	// If there are fewer than 16 teams (edge cases), just use all of them.
	return shuffled.slice(0, Math.min(16, shuffled.length));
};

// Standard bracket pairing: 1 vs N, 2 vs N-1, etc. Extra top seeds can get byes (away undefined).
const makeFirstRound = (seeded: PlayoffSeriesTeam[]) => {
	const teams = [...seeded].sort((a, b) => a.seed - b.seed);
	const matchups: { home: PlayoffSeriesTeam; away?: PlayoffSeriesTeam }[] = [];

	while (teams.length > 0) {
		const home = teams.shift()!;
		const away = teams.pop();
		matchups.push({
			home,
			away,
		});
	}

	return matchups;
};

const numRounds = (numTeams: number) => {
	return Math.ceil(Math.log2(Math.max(1, numTeams)));
};

const initSeries = (
	seeded: PlayoffSeriesTeam[],
): WeeklyTournamentSeries["series"] => {
	const rounds = numRounds(seeded.length);
	const series: WeeklyTournamentSeries["series"] = [];

	series[0] = makeFirstRound(seeded);
	for (let r = 1; r < rounds; r++) {
		// Preallocate correct length with placeholders. These get filled as teams advance.
		series[r] = Array(Math.ceil(series[r - 1]!.length / 2)).fill({
			home: {
				tid: -1,
				cid: -1,
				seed: 0,
				won: 0,
				pts: undefined,
			},
		});
	}

	return series;
};

export const startWeek = async (
	teams: TeamForWeeklyTournament[],
	week: number,
) => {
	const entrants = selectEntrants(teams, week);
	const seeded = makeSeeds(entrants);
	const state: WeeklyTournamentSeries = {
		season: g.get("season"),
		week,
		currentRound: 0,
		series: initSeries(seeded),
		complete: false,
	};

	// Persist state (not synced to UI unless added to gameAttributesSyncedToUi)
	await league.setGameAttributes({
		weeklyTournamentSeries: state,
	});

	// Schedule day 1: all matchups with 2 teams (no byes)
	const tids: [number, number][] = [];
	for (const matchup of state.series[0]!) {
		if (matchup.away) {
			tids.push([matchup.home.tid, matchup.away.tid]);
		}
	}

	// setSchedule overwrites whatever is currently in the schedule store
	await setSchedule(tids);
};

export const startWeek1 = async (teams: TeamForWeeklyTournament[]) => {
	await startWeek(teams, 1);
};
