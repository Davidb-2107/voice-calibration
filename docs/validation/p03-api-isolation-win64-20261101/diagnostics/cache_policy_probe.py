import json,sys
sys.path.insert(0,'C:\\Users\\dbele\\.codex\\worktrees\\1394\\Wiki_Claude\\.scratch\\p03-worktrees\\p03-internal-finance-service\\docs\\validation\\provider-registry-session\\preproduction')
if "--policy" in sys.argv:
    import operator_runtime
import p03_cache_fixture
print(json.dumps({"value":p03_cache_fixture.value,"isolated":sys.flags.isolated,"no_cache_write":sys.dont_write_bytecode,"python":sys.executable}))
