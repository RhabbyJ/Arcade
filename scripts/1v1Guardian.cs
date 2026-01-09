using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;
using System;
using System.Collections.Generic;
using System.Linq;

namespace OneVOneGuardian;

public class OneVOneGuardian : BasePlugin
{
    public override string ModuleName => "1v1 Guardian";
    public override string ModuleVersion => "1.0.3";

    // Remember intended teams by SteamID
    private readonly Dictionary<ulong, CsTeam> _teamBySteamId = new();

    // Reserve slots briefly to avoid "ghost slot" race on disconnect/reconnect
    private ulong? _reservedCt;
    private ulong? _reservedT;

    public override void Load(bool hotReload)
    {
        RegisterEventHandler<EventPlayerConnectFull>((@event, info) =>
        {
            var player = @event.Userid;
            if (player == null || !player.IsValid || player.IsBot) return HookResult.Continue;

            // Delay team assignment slightly so ChangeTeam sticks reliably
            Server.NextFrame(() =>
            {
                if (player == null || !player.IsValid || player.IsBot) return;

                var steamId = player.SteamID;

                // If we already know where they belong, re-apply it
                if (_teamBySteamId.TryGetValue(steamId, out var rememberedTeam))
                {
                    ForceTeam(player, rememberedTeam, $"Reconnected -> restoring {rememberedTeam}");
                    return;
                }

                // Otherwise assign based on availability (including reservations)
                AssignTeamDeterministic(player);
            });

            return HookResult.Continue;
        });

        // Disconnect cleanup to release reserved slots
        RegisterEventHandler<EventPlayerDisconnect>((@event, info) =>
        {
            var player = @event.Userid;
            if (player == null || !player.IsValid || player.IsBot) return HookResult.Continue;

            var steamId = player.SteamID;

            if (_reservedCt == steamId) _reservedCt = null;
            if (_reservedT == steamId) _reservedT = null;

            return HookResult.Continue;
        });

        // Block .ready / !ready before MatchZy sees it
        AddCommandListener("say", OnPlayerChat);
        AddCommandListener("say_team", OnPlayerChat);
    }

    private void AssignTeamDeterministic(CCSPlayerController player)
    {
        var humans = Utilities.GetPlayers()
            .Where(p => p != null && p.IsValid && !p.IsBot && !p.IsHLTV)
            .ToList();

        // Count currently occupied teams (exclude spectators)
        var ctCount = humans.Count(p => p.TeamNum == (byte)CsTeam.CounterTerrorist);
        var tCount  = humans.Count(p => p.TeamNum == (byte)CsTeam.Terrorist);

        // Consider reservation as occupied
        if (_reservedCt.HasValue) ctCount = Math.Max(ctCount, 1);
        if (_reservedT.HasValue)  tCount  = Math.Max(tCount, 1);

        if (ctCount == 0)
        {
            _reservedCt = player.SteamID;
            _teamBySteamId[player.SteamID] = CsTeam.CounterTerrorist;
            ForceTeam(player, CsTeam.CounterTerrorist, "Assigned to CT");
        }
        else if (tCount == 0)
        {
            _reservedT = player.SteamID;
            _teamBySteamId[player.SteamID] = CsTeam.Terrorist;
            ForceTeam(player, CsTeam.Terrorist, "Assigned to T");
        }
        else
        {
            ForceTeam(player, CsTeam.Spectator, "Match full -> Spectator");
        }
    }

    private void ForceTeam(CCSPlayerController player, CsTeam team, string reason)
    {
        player.ChangeTeam(team);
        Console.WriteLine($"[Guardian] {reason}: {player.PlayerName} ({player.SteamID})");
    }

    private HookResult OnPlayerChat(CCSPlayerController? player, CommandInfo info)
    {
        if (player == null || !player.IsValid) return HookResult.Continue;

        var raw = info.ArgString.Replace("\"", "").Trim().ToLower();
        if (string.IsNullOrWhiteSpace(raw)) return HookResult.Continue;

        // Tokenize: block if FIRST token is .ready or !ready
        var firstToken = raw.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (firstToken == ".ready" || firstToken == "!ready")
        {
            player.PrintToChat(" \x02[1v1]\x01 Auto-start only. Please wait for the warmup timer.");
            return HookResult.Handled;
        }

        return HookResult.Continue;
    }
}
