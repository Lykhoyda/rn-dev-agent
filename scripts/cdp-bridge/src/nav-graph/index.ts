export type {
  NavigatorKind,
  NavLibrary,
  NavScreen,
  NavNavigator,
  NavGraphMeta,
  NavGraph,
  RawRoute,
  RawNavigator,
  RawNavTopology,
  NavGraphScanResult,
  NavMethod,
  NavigationStep,
  NavigationPlan,
  NavigationPrerequisite,
  NavActionRecord,
  StrikeEntry,
  NavRecordInput,
  NavRecordResult,
  StalenessCheck,
  PlaybookEntry,
  SelfHealResult,
} from './types.js';

export type { MergeResult } from './storage.js';

export {
  findProjectRoot,
  getGraphPath,
  readGraph,
  writeGraph,
  buildGraph,
  mergeGraph,
  recordNavigation,
  isMethodCooledDown,
  getStrikeStatus,
  hydrateStrikesFromGraph,
} from './storage.js';

export {
  findRouteInGraph,
  listAllRoutes,
  getNavigatorSubtree,
  buildNavigationPlan,
} from './query.js';

export {
  checkStaleness,
  getHeadCommit,
  getPlaybook,
  getPlaybookForContext,
  buildSelfHealAdvice,
  stampGraphWithCommit,
} from './self-heal.js';
