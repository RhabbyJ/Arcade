using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;

namespace OneVOneGuardian;

public class OneVOneGuardian : BasePlugin
{
    public override string ModuleName => "1v1 Guardian";
    public override string ModuleVersion => "1.0.0";

    public override void Load(bool hotReload)
    {
        // 1. Hook Player Connect to force teams
        RegisterEventHandler<EventPlayerConnectFull>((@event, info) =>
        {
            var player = @event.Userid;
            if (player == null || !player.IsValid || player.IsBot) return HookResult.Continue;

            // Simple Logic: 
            // If CT is empty -> Join CT
            // If T is empty -> Join T
            // Else -> Spec
            
            var ctCount = Utilities.GetPlayers().Count(p => p.TeamNum == (byte)CsTeam.CounterTerrorist);
            var tCount = Utilities.GetPlayers().Count(p => p.TeamNum == (byte)CsTeam.Terrorist);

            if (ctCount == 0)
            {
                player.ChangeTeam(CsTeam.CounterTerrorist);
                Console.WriteLine($"[Guardian] Assigned {player.PlayerName} to CT");
            }
            else if (tCount == 0)
            {
                player.ChangeTeam(CsTeam.Terrorist);
                Console.WriteLine($"[Guardian] Assigned {player.PlayerName} to T");
            }
            else
            {
                player.ChangeTeam(CsTeam.Spectator);
                Console.WriteLine($"[Guardian] Match full. Assigned {player.PlayerName} to Spec");
            }

            return HookResult.Continue;
        });

        // 2. Intercept Chat to block .ready during Live Match
        AddCommandListener("say", OnPlayerChat);
        AddCommandListener("say_team", OnPlayerChat);
    }

    private HookResult OnPlayerChat(CCSPlayerController? player, CommandInfo info)
    {
        if (player == null || !player.IsValid) return HookResult.Continue;

        var msg = info.GetArg(1).ToLower();

        // Check if message is a trigger
        if (msg.Contains(".ready") || msg.Contains("!ready"))
        {
            // Check if Match is Live (Not in Warmup)
            var gameRules = Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules").FirstOrDefault()?.GameRules;
            if (gameRules != null && !gameRules.WarmupPeriod)
            {
                // Match is LIVE. Block the command.
                player.PrintToChat(" \x02[1v1]\x01 The match is live! .ready is disabled.");
                return HookResult.Handled; // This stops MatchZy from seeing it
            }
        }

        return HookResult.Continue;
    }
}
