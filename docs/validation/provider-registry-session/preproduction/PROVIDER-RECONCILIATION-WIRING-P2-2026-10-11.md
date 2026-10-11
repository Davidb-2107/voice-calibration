# P2 — Réconciliation fournisseur raccordée

L'outil MCP existant `reconcile_calibration` conserve son comportement historique lorsque `lookup_provider` est absent ou faux : lecture du run enregistré, sans requête fournisseur.

L'action explicite de collecte de preuves est :

```json
{
  "name": "reconcile_calibration",
  "arguments": {
    "workspace_id": "<workspace autorisé>",
    "run_id": "<run execution_unknown>",
    "lookup_provider": true
  }
}
```

Cette action vérifie l'autorisation du principal sur le workspace, l'identité de configuration du run et la correspondance du digest et de la configuration des tentatives. Le helper vérifie également le scope tenant/workspace du registre. La clé utilisée pour la lecture GET est capturée une fois et sert également à vérifier son identité de configuration.

Seuls les identifiants fournisseur connus déclenchent des lectures de l'historique ElevenLabs. Leur absence conserve le blocage sans requête. Les résultats sont enregistrés dans `result.provider_reconciliation`, avec une décision distinguant preuves complètes, partielles et insuffisantes. Le run reste `execution_unknown`, l'approbation reste consommée et `execution_allowed` reste faux. La collecte ne synthétise pas, ne publie pas le corpus et ne débloque pas automatiquement une restauration.

L'API historique continue d'appeler la lecture d'état sans ce flag. Le raccordement opérationnel explicite est disponible directement par MCP ; aucune route HTTP supplémentaire n'a été ajoutée.

## Vérification hors ligne

Avec le venv déclaré `wiki-claude` :

```text
python -m pytest Shared/voice-calibration/test_provider_history.py Shared/voice-calibration/test_provider_reconciliation_wiring.py Shared/voice-calibration/test_approval_gate.py Shared/voice-calibration/test_mcp_server.py -q --tb=short --basetemp .scratch/provider-wiring-final-tests
```

Résultat : **43 PASS, 3 SKIP**, un avertissement Pydantic préexistant. Lecteur fournisseur simulé uniquement. Couverture : flag explicite, persistance, impossibilité de replay, changement de credentials/tenant/workspace, refus d'un workspace étranger, digest de tentative incorrect, absence d'identifiants, preuves partielles et capture unique d'une clé pouvant changer.

Aucune lecture ElevenLabs réelle, synthèse, modification du runtime persistant, commit ou push. La réponse réelle de l'historique ElevenLabs reste à valider séparément.
