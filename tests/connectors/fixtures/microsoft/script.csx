// Fixture only. Ceremony never compiles, evaluates or uploads this file: the
// importer reads its NAME from settings.json and nothing else, and every
// operation the script covers is execution-blocked. The canary below exists so
// a test can prove the contents never reach a definition, an export or a
// diagnostic.
public class Script : ScriptBase
{
    public override async Task<HttpResponseMessage> ExecuteAsync()
    {
        // CANARY_SCRIPT_BODY_7d2
        var response = await this.Context.SendAsync(this.Context.Request, this.CancellationToken).ConfigureAwait(false);
        return response;
    }
}
