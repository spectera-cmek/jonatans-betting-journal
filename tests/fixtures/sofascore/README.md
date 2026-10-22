# Sofascore-fixturer

Handgjorda efter Sofascores svarsformat (period → groups → statisticsItems,
lineups → home/away → players → player/statistics). De ersätts av riktiga,
trimmade svar när `npm run sofascore:capture` körts — de hamnar i `live/`,
och testerna i `tests/sofascore.test.ts` kör mot dem också när de finns.
