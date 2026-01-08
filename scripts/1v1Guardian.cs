using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;
using System.Linq;

namespace OneVOneGuardian;

public class OneVOneGuardian : BasePlugin
{
    public override string ModuleName => "1v1 Guardian";
    public override string ModuleVersion => "1.0.2";

    public override void Load(bool hotReload)
    {
        // 1. Hook Player Connect to force teams
        RegisterEventHandler<EventPlayerConnectFull>((@event, info) =>
        {
            var player = @event.Userid;
            if (player == null || !player.IsValid || player.IsBot) return HookResult.Continue;

            // Get human players only
            var humans = Utilities.GetPlayers().Where(p => p != null && p.IsValid && !p.IsBot && !p.IsHLTV);
            
            var ctCount = humans.Count(p => p.TeamNum == (byte)CsTeam.CounterTerrorist);
            var tCount = humans.Count(p => p.TeamNum == (byte)CsTeam.Terrorist);

            // Force assignment logic
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

        // 2. AGGRESSIVE Chat Intercept
        // This hooks the command before other plugins (like MatchZy) can see it.
        AddCommandListener("say", OnPlayerChat);
        AddCommandListener("say_team", OnPlayerChat);
    }

    private HookResult OnPlayerChat(CCSPlayerController? player, CommandInfo info)
    {
        if (player == null || !player.IsValid) return HookResult.Continue;

        // Get the full message (args start at 1 for say commands)
        var msg = info.ArgString.Replace("\"", "").Trim().ToLower();

        // Block triggers
        if (msg == ".ready" || msg == "!ready" || msg.Contains(".ready"))
        {
            player.PrintToChat(" \x02[1v1]\x01 Match is auto-start only. Please wait for the timer!");
            return HookResult.Handled; // STOP MatchZy from seeing this
        }

        return HookResult.Continue;
    }
}
